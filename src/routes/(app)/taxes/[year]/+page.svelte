<script lang="ts">
  import PageHeader from "$lib/components/app/page-header.svelte";
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import XIcon from "@lucide/svelte/icons/x";
  import Amount from "$lib/components/Amount.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import DeductionsPanel from "$lib/components/tax/DeductionsPanel.svelte";
  import TaxOutcome from "$lib/components/tax/TaxOutcome.svelte";
  import TaxYearForm from "$lib/components/tax/TaxYearForm.svelte";
  import * as Alert from "$lib/components/ui/alert";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import * as Tabs from "$lib/components/ui/tabs";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import { formError, type FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { todayIso } from "$lib/format";
  import type { RowKind } from "$lib/server/tax/tax";
  import { cn } from "$lib/utils";
  import type { PageProps } from "./$types";
  import { usePreferences } from "$lib/preferences.svelte";

  const prefs = usePreferences();

  let { data }: PageProps = $props();

  const rec = $derived(data.reconciliation);
  const year = $derived(rec.year);
  const currency = $derived(year.currency);
  const balance = $derived(rec.balance);
  const differences = $derived(
    rec.counts.amount_mismatch +
      rec.counts.missing_office +
      rec.counts.missing_mine,
  );
  const reportHref = $derived(
    `${resolve("/reports/tax")}?year=${encodeURIComponent(String(year.year))}`,
  );

  const KIND: Record<RowKind, { label: string; class: string }> = {
    matched: {
      label: "Matched",
      class: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
    },
    amount_mismatch: {
      label: "Amount differs",
      class: "border-destructive/40 text-destructive",
    },
    missing_office: {
      label: "Not counted by tax office",
      class: "border-destructive/40 text-destructive",
    },
    missing_mine: {
      label: "Not in your payments",
      class: "border-destructive/40 text-destructive",
    },
  };

  let rowError = $state("");
  const rowAction = submitHandler({
    setPending: () => {},
    setErrors: (e) => (rowError = e.form?.[0] ?? ""),
    knownFields: [],
  });

  const creditUid = $props.id();
  let creditPending = $state(false);
  let creditErrors = $state<NonNullable<FormErrors>>({});
  let creditKey = $state(0);
  let deleteOpen = $state(false);

  const suggestionsFor = (creditId: string) =>
    rec.suggestions.filter((s) => s.creditId === creditId);
</script>

<svelte:head>
  <title>Tax {year.year} · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <div class="grid gap-3">
    <a
      href={resolve("/(app)/taxes")}
      class="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
    >
      <ArrowLeftIcon class="size-4" /> Taxes
    </a>
    <PageHeader
      title="Tax {year.year}"
      description={year.authority ?? "No tax authority entered"}
    >
      {#snippet actions()}
        <Button
          variant="outline"
          href={reportHref}
          data-sveltekit-reload
          download
        >
          <DownloadIcon /> PDF report
        </Button>
      {/snippet}
    </PageHeader>
  </div>

  <Tabs.Root value="reconciliation">
    <Tabs.List>
      <Tabs.Trigger value="reconciliation">Reconciliation</Tabs.Trigger>
      <Tabs.Trigger value="deductions">Deductions</Tabs.Trigger>
    </Tabs.List>
    <Tabs.Content value="reconciliation" class="grid gap-6 pt-4">
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card.Root>
          <Card.Header>
            <Card.Description>Paid by you</Card.Description>
            <Card.Title class="text-xl">
              <Amount value={balance.paidByMe} {currency} />
            </Card.Title>
          </Card.Header>
        </Card.Root>
        <Card.Root>
          <Card.Header>
            <Card.Description>Counted by the tax office</Card.Description>
            <Card.Title class="text-xl">
              <Amount value={balance.creditedByOffice} {currency} />
            </Card.Title>
          </Card.Header>
        </Card.Root>
        <Card.Root>
          <Card.Header>
            <Card.Description>Assessed total</Card.Description>
            <Card.Title class="text-xl">
              {#if balance.assessedTotal === null}
                <span class="text-muted-foreground">Not entered</span>
              {:else}
                <Amount value={balance.assessedTotal} {currency} />
              {/if}
            </Card.Title>
          </Card.Header>
        </Card.Root>
        <Card.Root>
          <Card.Header>
            <Card.Description>
              {balance.outcome === "refund" ? "Refund to expect" : "Still open"}
            </Card.Description>
            <Card.Title class="text-xl">
              <TaxOutcome {balance} {currency} />
            </Card.Title>
            {#if balance.remainingByMe !== null && balance.remainingByMe !== balance.remaining}
              <p class="text-muted-foreground text-xs">
                By your payments: <Amount
                  value={balance.remainingByMe}
                  {currency}
                />
              </p>
            {/if}
          </Card.Header>
        </Card.Root>
      </div>

      {#if rec.otherCurrencyLines > 0}
        <Alert.Root>
          <TriangleAlertIcon />
          <Alert.Description>
            {rec.otherCurrencyLines} tagged
            {rec.otherCurrencyLines === 1 ? "payment is" : "payments are"} in another
            currency than {currency} and not counted here.
          </Alert.Description>
        </Alert.Root>
      {/if}

      <Card.Root>
        <Card.Header>
          <Card.Title class="flex flex-wrap items-center gap-2">
            Reconciliation
            {#if rec.reconciled}
              <Badge
                variant="outline"
                class="border-emerald-600/40 text-emerald-700 dark:text-emerald-400"
              >
                <CircleCheckIcon /> All lines match
              </Badge>
            {:else if differences > 0}
              <Badge
                variant="outline"
                class="border-destructive/40 text-destructive"
              >
                <TriangleAlertIcon />
                {differences}
                {differences === 1 ? "difference" : "differences"}
              </Badge>
            {/if}
          </Card.Title>
          <Card.Description>
            Your payments on the left, the tax office's statement on the right.
            Lines are paired by reference, amount and date (within a week).
          </Card.Description>
        </Card.Header>
        <Card.Content class="grid gap-3">
          <FormAlert message={rowError || undefined} />
          {#if rec.rows.length === 0}
            <Empty.Root class="border border-dashed">
              <Empty.Header>
                <Empty.Title>Nothing to compare yet</Empty.Title>
                <Empty.Description>
                  Add the lines from the tax office's statement below, and mark
                  your payments with this tax year in the transaction details.
                </Empty.Description>
              </Empty.Header>
            </Empty.Root>
          {:else}
            <ul class="grid gap-2">
              {#each rec.rows as row (row.mine?.id ?? row.office?.id)}
                <li
                  class={cn(
                    "grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]",
                    row.kind !== "matched" &&
                      "border-destructive/40 bg-destructive/5",
                  )}
                >
                  <div class="min-w-0">
                    <p class="text-muted-foreground text-xs">Your payment</p>
                    {#if row.mine}
                      <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                          <p class="text-sm">{prefs.date(row.mine.date)}</p>
                          {#if row.mine.label}
                            <p class="truncate text-sm">{row.mine.label}</p>
                          {/if}
                          {#if row.mine.reference}
                            <p
                              class="text-muted-foreground truncate font-mono text-xs"
                            >
                              {row.mine.reference}
                            </p>
                          {/if}
                          <a
                            class="text-muted-foreground text-xs underline-offset-4 hover:underline"
                            href={resolve("/(app)/accounts/[id]", {
                              id: row.mine.accountId,
                            })}
                          >
                            {row.mine.via === "bill"
                              ? "Via a tagged bill"
                              : "Tagged transaction"}
                          </a>
                        </div>
                        <div class="flex items-center gap-1">
                          <Amount
                            value={row.mine.amount}
                            {currency}
                            class="font-medium"
                          />
                          {#if row.mine.via === "tagged"}
                            <form
                              method="POST"
                              action="?/untag"
                              use:enhance={rowAction}
                            >
                              <input
                                type="hidden"
                                name="transactionId"
                                value={row.mine.transactionId}
                              />
                              <Button
                                type="submit"
                                variant="ghost"
                                size="icon"
                                class="size-7"
                                aria-label="Remove the tax year from this transaction"
                              >
                                <XIcon />
                              </Button>
                            </form>
                          {/if}
                        </div>
                      </div>
                    {:else}
                      <p class="text-destructive text-sm font-medium">
                        Missing
                      </p>
                    {/if}
                  </div>

                  <div class="min-w-0">
                    <p class="text-muted-foreground text-xs">Tax office</p>
                    {#if row.office}
                      <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                          <p class="text-sm">{prefs.date(row.office.date)}</p>
                          {#if row.office.description}
                            <p class="truncate text-sm">
                              {row.office.description}
                            </p>
                          {/if}
                          {#if row.office.reference}
                            <p
                              class="text-muted-foreground truncate font-mono text-xs"
                            >
                              {row.office.reference}
                            </p>
                          {/if}
                        </div>
                        <div class="flex items-center gap-1">
                          <Amount
                            value={row.office.amount}
                            {currency}
                            class="font-medium"
                          />
                          <form
                            method="POST"
                            action="?/deleteCredit"
                            use:enhance={rowAction}
                          >
                            <input
                              type="hidden"
                              name="creditId"
                              value={row.office.id}
                            />
                            <Button
                              type="submit"
                              variant="ghost"
                              size="icon"
                              class="size-7"
                              aria-label="Delete this statement line"
                            >
                              <Trash2Icon />
                            </Button>
                          </form>
                        </div>
                      </div>
                    {:else}
                      <p class="text-destructive text-sm font-medium">
                        Missing
                      </p>
                    {/if}
                  </div>

                  <div class="flex flex-col items-start gap-1 sm:items-end">
                    <Badge variant="outline" class={KIND[row.kind].class}>
                      {KIND[row.kind].label}
                    </Badge>
                    {#if row.kind !== "matched"}
                      <span class="text-xs whitespace-nowrap tabular-nums">
                        {row.difference > 0 ? "+" : ""}<Amount
                          value={row.difference}
                          {currency}
                        />
                      </span>
                    {/if}
                  </div>

                  {#if row.kind === "missing_mine" && row.office}
                    {#each suggestionsFor(row.office.id) as s (s.transactionId)}
                      <div
                        class="bg-background flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm sm:col-span-3"
                      >
                        <span class="min-w-0">
                          Possible payment: {prefs.date(s.bookingDate)}
                          {#if s.label}· {s.label}{/if}
                          · <Amount value={s.amount} {currency} />
                        </span>
                        <form
                          method="POST"
                          action="?/tag"
                          use:enhance={rowAction}
                        >
                          <input
                            type="hidden"
                            name="transactionId"
                            value={s.transactionId}
                          />
                          <Button type="submit" size="sm" variant="secondary">
                            Count as tax payment
                          </Button>
                        </form>
                      </div>
                    {/each}
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Card.Title>Add a statement line</Card.Title>
          <Card.Description>
            From the tax office's account statement. Use a minus sign for money
            they paid back to you.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          {#key creditKey}
            <form
              method="POST"
              action="?/addCredit"
              class="grid gap-4"
              use:enhance={submitHandler({
                setPending: (v) => (creditPending = v),
                setErrors: (e) => (creditErrors = e),
                knownFields: [
                  "bookingDate",
                  "amount",
                  "reference",
                  "description",
                ],
                successMessage: "Statement line added",
                onSuccess: () => creditKey++,
              })}
            >
              <FormAlert message={formError(creditErrors)} />
              <div class="grid gap-4 sm:grid-cols-2">
                <FormField
                  label="Date"
                  for="{creditUid}-date"
                  errors={creditErrors.bookingDate}
                >
                  <Input
                    id="{creditUid}-date"
                    name="bookingDate"
                    type="date"
                    required
                    value={todayIso()}
                    aria-invalid={!!creditErrors.bookingDate}
                  />
                </FormField>
                <FormField
                  label="Amount"
                  for="{creditUid}-amount"
                  errors={creditErrors.amount}
                >
                  <Input
                    id="{creditUid}-amount"
                    name="amount"
                    inputmode="decimal"
                    required
                    class="tabular-nums"
                    placeholder="1000.00"
                    aria-invalid={!!creditErrors.amount}
                  />
                </FormField>
                <FormField
                  label="Reference (optional)"
                  for="{creditUid}-ref"
                  errors={creditErrors.reference}
                >
                  <Input
                    id="{creditUid}-ref"
                    name="reference"
                    maxlength={35}
                    class="font-mono"
                    aria-invalid={!!creditErrors.reference}
                  />
                </FormField>
                <FormField
                  label="Description (optional)"
                  for="{creditUid}-desc"
                  errors={creditErrors.description}
                >
                  <Input
                    id="{creditUid}-desc"
                    name="description"
                    maxlength={500}
                    placeholder="Provisional invoice, instalment 1"
                    aria-invalid={!!creditErrors.description}
                  />
                </FormField>
              </div>
              <div>
                <Button type="submit" disabled={creditPending}>
                  {#if creditPending}<Spinner />{:else}<PlusIcon />{/if}
                  Add line
                </Button>
              </div>
            </form>
          {/key}
        </Card.Content>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Card.Title>Details</Card.Title>
          <Card.Description>
            The tax authority and the assessed total of the final assessment.
          </Card.Description>
        </Card.Header>
        <Card.Content class="grid gap-4">
          <TaxYearForm
            action="?/saveDetails"
            year={year.year}
            authority={year.authority}
            {currency}
            assessedTotal={year.assessedTotal}
            notes={year.notes}
            submitLabel="Save details"
            successMessage="Details saved"
          />
          {#if year.id !== null}
            <div class="border-t pt-4">
              <Button
                variant="outline"
                class="text-destructive"
                onclick={() => (deleteOpen = true)}
              >
                <Trash2Icon /> Delete this tax year's details
              </Button>
            </div>
          {/if}
        </Card.Content>
      </Card.Root>
    </Tabs.Content>
    <Tabs.Content value="deductions" class="pt-4">
      <DeductionsPanel
        summary={data.deductions}
        mappings={data.deductionMappings}
      />
    </Tabs.Content>
  </Tabs.Root>
</div>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title="Delete the details of tax year {year.year}?"
  description="The authority, assessed total and the tax office's statement lines are removed. Transactions and bills you tagged with this year keep their tag."
  action="?/deleteYear"
  successMessage="Tax year deleted"
/>
