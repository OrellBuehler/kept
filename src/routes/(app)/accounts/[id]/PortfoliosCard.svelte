<script lang="ts">
  import { enhance } from "$app/forms";
  import { tick } from "svelte";
  import { toast } from "svelte-sonner";
  import * as Card from "$lib/components/ui/card";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import * as Empty from "$lib/components/ui/empty";
  import * as Select from "$lib/components/ui/select";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import Amount from "$lib/components/Amount.svelte";
  import CopyButton from "$lib/components/app/copy-button.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { todayIso } from "$lib/format";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { formatIban, isQrIban } from "$lib/iban";
  import {
    PORTFOLIO_CLOSE_REASONS,
    PORTFOLIO_CLOSE_REASON_LABELS,
    type PortfolioCloseReason,
  } from "$lib/pillar-3a-types";
  import { formatReference } from "$lib/references";
  import type { PortfolioValueView, PortfolioView } from "$lib/server/pillar3a";
  import { usePreferences } from "$lib/preferences.svelte";
  import ArchiveRestoreIcon from "@lucide/svelte/icons/archive-restore";
  import BriefcaseIcon from "@lucide/svelte/icons/briefcase-business";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import LockIcon from "@lucide/svelte/icons/lock";
  import MoreHorizontalIcon from "@lucide/svelte/icons/ellipsis";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import PortfolioFormDialog from "./PortfolioFormDialog.svelte";
  import PortfolioHistorySheet from "./PortfolioHistorySheet.svelte";
  import PortfolioValuesDialog from "./PortfolioValuesDialog.svelte";

  const prefs = usePreferences();

  let {
    portfolios,
    values,
    currency,
    depositIban,
    contractNumber,
  }: {
    portfolios: PortfolioView[];
    /** Value history per portfolio id, newest first. */
    values: Record<string, PortfolioValueView[]>;
    currency: string;
    depositIban: string | null;
    contractNumber: string | null;
  } = $props();

  const uid = $props.id();
  const open = $derived(portfolios.filter((p) => p.closedOn === null));
  const closed = $derived(portfolios.filter((p) => p.closedOn !== null));
  const qrIban = $derived(depositIban !== null && isQrIban(depositIban));

  let formOpen = $state(false);
  let editing = $state<PortfolioView | null>(null);
  let valuesOpen = $state(false);
  let historyOpen = $state(false);
  let historyId = $state<string | null>(null);
  let deleteOpen = $state(false);
  let deleting = $state<PortfolioView | null>(null);
  let deleteValueOpen = $state(false);
  let deletingValue = $state<PortfolioValueView | null>(null);

  const history = $derived(historyId ? (values[historyId] ?? []) : []);
  const historyName = $derived(
    portfolios.find((p) => p.id === historyId)?.name ?? "Portfolio",
  );

  function add() {
    editing = null;
    formOpen = true;
  }
  function edit(p: PortfolioView) {
    editing = p;
    formOpen = true;
  }
  function showHistory(p: PortfolioView) {
    historyId = p.id;
    historyOpen = true;
  }
  function askDelete(p: PortfolioView) {
    deleting = p;
    deleteOpen = true;
  }

  // close dialog
  let closeOpen = $state(false);
  let closing = $state<PortfolioView | null>(null);
  let closePending = $state(false);
  let closeErrors = $state<NonNullable<FormErrors>>({});
  let closeReason = $state<PortfolioCloseReason>("age");

  function askClose(p: PortfolioView) {
    closing = p;
    closeErrors = {};
    closeReason = "age";
    closeOpen = true;
  }

  // reopen
  let reopenForm = $state<HTMLFormElement | null>(null);
  let reopenId = $state("");
  let reopenPending = $state(false);

  async function reopen(p: PortfolioView) {
    if (reopenPending) return;
    reopenId = p.id;
    await tick();
    reopenForm?.requestSubmit();
  }
</script>

{#snippet portfolioRow(p: PortfolioView)}
  <li class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
    <div class="grid min-w-0 gap-1">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium break-words">{p.name}</span>
        {#if p.closedOn}
          <Badge variant="outline">
            <LockIcon />
            Closed {prefs.date(p.closedOn)}
          </Badge>
        {/if}
      </div>
      {#if p.strategy || p.number}
        <div class="text-muted-foreground text-sm break-words">
          {[p.strategy, p.number ? `No. ${p.number}` : null]
            .filter(Boolean)
            .join(" · ")}
        </div>
      {/if}
      {#if p.closeReason}
        <div class="text-muted-foreground text-xs">
          {PORTFOLIO_CLOSE_REASON_LABELS[p.closeReason]}
        </div>
      {/if}
      {#if p.depositReference}
        <div class="flex flex-wrap items-center gap-1">
          <span class="font-mono text-xs break-all">
            {formatReference(p.depositReference)}
          </span>
          <CopyButton
            value={p.depositReference}
            label="Copy reference of {p.name}"
            copiedMessage="Reference copied"
            iconOnly
          />
        </div>
      {/if}
    </div>
    <div class="flex items-start gap-2">
      <div class="text-end">
        {#if p.latestValue !== null}
          <Amount
            value={p.latestValue}
            {currency}
            class="text-lg font-semibold"
          />
          {#if p.latestValueDate}
            <div class="text-muted-foreground text-xs">
              as of {prefs.date(p.latestValueDate)}
            </div>
          {/if}
        {:else}
          <span class="text-muted-foreground text-sm">No value yet</span>
        {/if}
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="ghost"
              size="icon-sm"
              aria-label="Actions for {p.name}"
            >
              <MoreHorizontalIcon />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-48">
          <DropdownMenu.Item onSelect={() => showHistory(p)}>
            <HistoryIcon /> Value history
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => edit(p)}>
            <PencilIcon /> Edit
          </DropdownMenu.Item>
          {#if p.closedOn}
            <DropdownMenu.Item onSelect={() => reopen(p)}>
              <ArchiveRestoreIcon /> Reopen
            </DropdownMenu.Item>
          {:else}
            <DropdownMenu.Item onSelect={() => askClose(p)}>
              <LockIcon /> Close
            </DropdownMenu.Item>
          {/if}
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            variant="destructive"
            onSelect={() => askDelete(p)}
          >
            <Trash2Icon /> Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </li>
{/snippet}

<Card.Root>
  <Card.Header>
    <Card.Title>Portfolios</Card.Title>
    <Card.Description>
      Each portfolio is valued by hand from your provider's statement. Their
      values are added to the cash balance of this account.
    </Card.Description>
  </Card.Header>
  <Card.Content class="grid gap-6">
    <div class="flex flex-wrap justify-end gap-2">
      {#if open.length > 0}
        <Button size="sm" variant="outline" onclick={() => (valuesOpen = true)}>
          <RefreshCwIcon /> Update values
        </Button>
      {/if}
      <Button size="sm" variant="outline" onclick={add}>
        <PlusIcon /> Add portfolio
      </Button>
    </div>
    {#if portfolios.length === 0}
      <Empty.Root class="border border-dashed">
        <Empty.Header>
          <Empty.Media variant="icon"><BriefcaseIcon /></Empty.Media>
          <Empty.Title>No portfolios</Empty.Title>
          <Empty.Description>
            Add each portfolio of this contract with its payment reference, then
            record its value from time to time.
          </Empty.Description>
        </Empty.Header>
        <Empty.Content>
          <Button size="sm" onclick={add}>
            <PlusIcon /> Add portfolio
          </Button>
        </Empty.Content>
      </Empty.Root>
    {:else}
      <ul class="divide-y">
        {#each open as p (p.id)}
          {@render portfolioRow(p)}
        {/each}
      </ul>
      {#if closed.length > 0}
        <div class="grid gap-1">
          <h3 class="text-muted-foreground text-sm font-medium">Closed</h3>
          <ul class="divide-y">
            {#each closed as p (p.id)}
              {@render portfolioRow(p)}
            {/each}
          </ul>
        </div>
      {/if}
    {/if}

    {#if depositIban || contractNumber}
      <div class="grid gap-2 rounded-md border p-3">
        <h3 class="text-sm font-medium">Deposit details</h3>
        <p class="text-muted-foreground text-xs">
          Use these to pay into a portfolio: the IBAN, plus the portfolio's own
          reference above.
        </p>
        <dl class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          {#if contractNumber}
            <dt class="text-muted-foreground">Contract number</dt>
            <dd class="font-mono break-all">{contractNumber}</dd>
          {/if}
          {#if depositIban}
            <dt class="text-muted-foreground">
              {qrIban ? "QR-IBAN" : "IBAN"}
            </dt>
            <dd class="flex flex-wrap items-center gap-1">
              {#if prefs.ibanDisplay === "hidden"}
                <span class="text-muted-foreground">
                  Hidden by your IBAN display setting
                </span>
              {:else}
                <span class="font-mono break-all">
                  {prefs.iban(depositIban)}
                </span>
              {/if}
              <CopyButton
                value={formatIban(depositIban)}
                label="Copy deposit IBAN"
                copiedMessage="IBAN copied"
                iconOnly
              />
            </dd>
          {/if}
        </dl>
      </div>
    {/if}
  </Card.Content>
</Card.Root>

<PortfolioFormDialog bind:open={formOpen} portfolio={editing} {qrIban} />
<PortfolioValuesDialog bind:open={valuesOpen} portfolios={open} {currency} />
<PortfolioHistorySheet
  bind:open={historyOpen}
  name={historyName}
  values={history}
  {currency}
  onDelete={(v) => {
    deletingValue = v;
    historyOpen = false;
    deleteValueOpen = true;
  }}
/>

<Dialog.Root bind:open={closeOpen}>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Close {closing?.name ?? "portfolio"}</Dialog.Title>
      <Dialog.Description>
        A withdrawal dissolves the whole portfolio. From the closing date on it
        no longer counts towards your balance. Enter its final value first if
        you want it kept in the history.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action="?/closePortfolio"
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (closePending = v),
        setErrors: (e) => (closeErrors = e),
        knownFields: ["closedOn", "closeReason"],
        successMessage: "Portfolio closed",
        onSuccess: () => (closeOpen = false),
      })}
    >
      <input type="hidden" name="portfolioId" value={closing?.id ?? ""} />
      <input type="hidden" name="closeReason" value={closeReason} />
      <FormField
        label="Closed on"
        for="{uid}-closed-on"
        errors={closeErrors.closedOn}
      >
        <Input
          id="{uid}-closed-on"
          name="closedOn"
          type="date"
          required
          value={todayIso()}
          aria-invalid={!!closeErrors.closedOn}
        />
      </FormField>
      <FormField
        label="Reason"
        for="{uid}-reason"
        errors={closeErrors.closeReason}
      >
        <Select.Root type="single" bind:value={closeReason}>
          <Select.Trigger id="{uid}-reason" aria-label="Reason" class="w-full">
            <span class="truncate">
              {PORTFOLIO_CLOSE_REASON_LABELS[closeReason]}
            </span>
          </Select.Trigger>
          <Select.Content>
            {#each PORTFOLIO_CLOSE_REASONS as r (r)}
              <Select.Item value={r} label={PORTFOLIO_CLOSE_REASON_LABELS[r]}>
                {PORTFOLIO_CLOSE_REASON_LABELS[r]}
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </FormField>
      {#if closeErrors.form?.length}
        <p class="text-destructive text-sm" role="alert">
          {closeErrors.form.join(" ")}
        </p>
      {/if}
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => (closeOpen = false)}
          disabled={closePending}>Cancel</Button
        >
        <Button type="submit" disabled={closePending}>
          {#if closePending}<Spinner />{/if}
          Close portfolio
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<form
  method="POST"
  action="?/reopenPortfolio"
  bind:this={reopenForm}
  class="hidden"
  use:enhance={submitHandler({
    setPending: (v) => (reopenPending = v),
    setErrors: (e) => {
      const message = Object.values(e).flat()[0];
      if (message) toast.error(message);
    },
    successMessage: "Portfolio reopened",
  })}
>
  <input type="hidden" name="portfolioId" value={reopenId} />
</form>

<ConfirmActionDialog
  bind:open={deleteOpen}
  title="Delete {deleting?.name ?? 'this portfolio'}?"
  description="This is only possible while the portfolio has no values and no contributions. Close it instead to keep its history."
  action="?/deletePortfolio"
  fields={{ portfolioId: deleting?.id ?? "" }}
  successMessage="Portfolio deleted"
/>

<ConfirmActionDialog
  bind:open={deleteValueOpen}
  title="Delete this value?"
  description="The value recorded on {deletingValue
    ? prefs.date(deletingValue.date)
    : ''} will be removed."
  action="?/deletePortfolioValue"
  fields={{
    portfolioId: historyId ?? "",
    valueId: deletingValue?.id ?? "",
  }}
  successMessage="Value deleted"
/>
