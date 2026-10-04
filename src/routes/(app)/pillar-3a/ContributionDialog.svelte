<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { Button } from "$lib/components/ui/button";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { Spinner } from "$lib/components/ui/spinner";
  import Amount from "$lib/components/Amount.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { minorToInput } from "$lib/amount-input";
  import { todayIso } from "$lib/format";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { PILLAR_3A_CURRENCY, type GapYear } from "$lib/pillar-3a";
  import type { Pillar3aContributionKind } from "$lib/pillar-3a-types";
  import type {
    ContributionView,
    Pillar3aPortfolioOverview,
  } from "$lib/server/pillar3a";
  import CircleAlertIcon from "@lucide/svelte/icons/circle-alert";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";

  let {
    open = $bindable(false),
    contribution = null,
    presetKind = null,
    portfolios,
    gaps,
  }: {
    open?: boolean;
    /** The contribution being edited; null to add a manual one. */
    contribution?: ContributionView | null;
    /** Opens an edit with this kind already chosen (e.g. "mark as buy-in"). */
    presetKind?: Pillar3aContributionKind | null;
    portfolios: Pillar3aPortfolioOverview[];
    gaps: GapYear[];
  } = $props();

  const currency = PILLAR_3A_CURRENCY;
  const uid = $props.id();
  const detected = $derived(contribution?.source === "detected");
  const editing = $derived(contribution !== null);

  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let kind = $state<Pillar3aContributionKind>("ordinary");
  let date = $state("");
  let amount = $state("");
  let portfolioId = $state("");
  let selectedYears = $state<number[]>([]);

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      kind = presetKind ?? contribution?.kind ?? "ordinary";
      date = contribution?.date ?? todayIso();
      amount = contribution ? minorToInput(contribution.amount, currency) : "";
      portfolioId =
        contribution?.portfolioId ?? portfolios[0]?.portfolioId ?? "";
      selectedYears = [...(contribution?.gapYears ?? [])];
      check = null;
      checkFailed = false;
    });
  });

  // Gap years this buy-in may still close: open ones, plus those it holds.
  const candidates = $derived(
    gaps.filter(
      (g) =>
        g.closedBy === null ||
        (contribution?.id != null && g.closedBy === contribution.id),
    ),
  );
  const gapYearsValue = $derived(
    selectedYears.toSorted((a, b) => a - b).join(","),
  );

  function toggleYear(year: number, on: boolean) {
    selectedYears = on
      ? [...selectedYears.filter((y) => y !== year), year]
      : selectedYears.filter((y) => y !== year);
  }

  let check = $state<{ errors: string[]; warnings: string[] } | null>(null);
  let checking = $state(false);
  let checkFailed = $state(false);

  // Live preview of the buy-in rules, debounced; a newer request cancels the older.
  $effect(() => {
    if (!open || kind !== "buy_in") {
      untrack(() => {
        check = null;
        checkFailed = false;
      });
      return;
    }
    const params = new URLSearchParams({
      date,
      amount,
      gapYears: gapYearsValue,
      ...(contribution ? { key: contribution.key } : {}),
    });
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      checking = true;
      try {
        const res = await fetch(`/api/pillar-3a/buy-in-check?${params}`, {
          signal: controller.signal,
        });
        if (res.status === 400) {
          // Incomplete input (e.g. a half-typed date): nothing to check yet.
          check = null;
          checkFailed = false;
        } else if (!res.ok) {
          throw new Error(`buy-in check failed: ${res.status}`);
        } else {
          check = await res.json();
          checkFailed = false;
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("buy-in check failed", err);
        check = null;
        checkFailed = true;
      } finally {
        if (!controller.signal.aborted) checking = false;
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
      checking = false;
    };
  });

  const knownFields = [
    "portfolioId",
    "date",
    "amount",
    "kind",
    "gapYears",
    "note",
    "contributionId",
    "transactionId",
  ];
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>
        {editing ? "Edit contribution" : "Add contribution"}
      </Dialog.Title>
      <Dialog.Description>
        {#if detected}
          Detected from a payment. The amount comes from the payment; set the
          date it was credited if it differs.
        {:else}
          Record a payment the app cannot see, e.g. one from an account you do
          not track.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action={editing ? "?/updateContribution" : "?/addContribution"}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields,
        successMessage: editing ? "Contribution updated" : "Contribution added",
        onSuccess: () => (open = false),
        onSuccessData: (data) => {
          const warnings = data?.warnings;
          if (Array.isArray(warnings)) {
            for (const w of warnings) toast.warning(String(w));
          }
        },
      })}
    >
      {#if contribution && detected}
        <input
          type="hidden"
          name="transactionId"
          value={contribution.transactionId}
        />
      {:else if contribution}
        <input type="hidden" name="contributionId" value={contribution.id} />
      {/if}
      <input
        type="hidden"
        name="gapYears"
        value={kind === "buy_in" ? gapYearsValue : ""}
      />

      {#if detected && contribution}
        <div
          class="flex flex-wrap items-baseline justify-between gap-2 text-sm"
        >
          <span class="text-muted-foreground">{contribution.portfolioName}</span
          >
          <Amount
            value={contribution.amount}
            {currency}
            class="font-semibold"
          />
        </div>
      {:else}
        <FormField
          label="Portfolio"
          for="{uid}-portfolio"
          errors={errors.portfolioId}
        >
          <NativeSelect.Root
            id="{uid}-portfolio"
            name="portfolioId"
            bind:value={portfolioId}
            class="w-full"
            required
          >
            {#each portfolios as p (p.portfolioId)}
              <NativeSelect.Option value={p.portfolioId}>
                {p.name} · {p.accountName}
              </NativeSelect.Option>
            {/each}
          </NativeSelect.Root>
        </FormField>
        <FormField
          label="Amount ({currency})"
          for="{uid}-amount"
          errors={errors.amount}
        >
          <Input
            id="{uid}-amount"
            name="amount"
            inputmode="decimal"
            autocomplete="off"
            required
            class="text-end tabular-nums"
            placeholder="0.00"
            bind:value={amount}
            aria-invalid={!!errors.amount}
          />
        </FormField>
      {/if}

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Credit date"
          for="{uid}-date"
          errors={errors.date}
          hint="The year it was credited sets the tax year."
        >
          <Input
            id="{uid}-date"
            name="date"
            type="date"
            required
            bind:value={date}
            aria-invalid={!!errors.date}
          />
        </FormField>
        <FormField label="Type" for="{uid}-kind" errors={errors.kind}>
          <NativeSelect.Root
            id="{uid}-kind"
            name="kind"
            bind:value={kind}
            class="w-full"
          >
            <NativeSelect.Option value="ordinary">Ordinary</NativeSelect.Option>
            <NativeSelect.Option value="buy_in">Buy-in</NativeSelect.Option>
          </NativeSelect.Root>
        </FormField>
      </div>

      {#if kind === "buy_in"}
        <fieldset class="grid gap-2">
          <legend class="text-sm leading-none font-medium">
            Gap years to close
          </legend>
          {#if candidates.length === 0}
            <p class="text-muted-foreground text-sm">
              No open gap years. Buy-ins can close gaps from 2025 on, for years
              before the current one.
            </p>
          {:else}
            <div class="grid gap-2">
              {#each candidates as g (g.year)}
                <div class="flex items-center gap-2">
                  <Checkbox
                    id="{uid}-gap-{g.year}"
                    checked={selectedYears.includes(g.year)}
                    onCheckedChange={(v) => toggleYear(g.year, v === true)}
                  />
                  <Label
                    for="{uid}-gap-{g.year}"
                    class="flex flex-wrap items-baseline gap-x-2 font-normal"
                  >
                    <span class="tabular-nums">{g.year}</span>
                    <span class="text-muted-foreground text-xs">
                      gap <Amount value={g.gap} {currency} />
                    </span>
                  </Label>
                </div>
              {/each}
            </div>
          {/if}
          {#if errors.gapYears?.length}
            <p class="text-destructive text-sm" role="alert">
              {errors.gapYears[0]}
            </p>
          {/if}

          <div class="grid gap-1.5" aria-live="polite">
            {#if checking}
              <p
                class="text-muted-foreground flex items-center gap-1.5 text-xs"
              >
                <Spinner class="size-3" /> Checking the buy-in rules
              </p>
            {/if}
            {#if checkFailed}
              <p class="text-destructive text-sm" role="alert">
                Could not check the buy-in rules. Saving still validates them.
              </p>
            {/if}
            {#each check?.errors ?? [] as message (message)}
              <p class="text-destructive flex gap-1.5 text-sm" role="alert">
                <CircleAlertIcon class="mt-0.5 size-4 shrink-0" />
                {message}
              </p>
            {/each}
            {#each check?.warnings ?? [] as message (message)}
              <p
                class="flex gap-1.5 text-sm text-amber-700 dark:text-amber-400"
              >
                <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
                {message}
              </p>
            {/each}
          </div>
        </fieldset>
      {/if}

      <FormField label="Note (optional)" for="{uid}-note" errors={errors.note}>
        <Input
          id="{uid}-note"
          name="note"
          maxlength={1000}
          value={contribution?.note ?? ""}
        />
      </FormField>

      {#if errors.form?.length}
        <p class="text-destructive text-sm" role="alert">
          {errors.form.join(" ")}
        </p>
      {/if}
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => (open = false)}
          disabled={pending}>Cancel</Button
        >
        <Button type="submit" disabled={pending}>
          {#if pending}<Spinner />{/if}
          {editing ? "Save" : "Add contribution"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
