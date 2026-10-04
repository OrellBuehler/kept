<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Spinner } from "$lib/components/ui/spinner";
  import Amount from "$lib/components/Amount.svelte";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { plural } from "$lib/import-ui";
  import { usePreferences } from "$lib/preferences.svelte";
  import type { TransferCandidate } from "$lib/server/transfers/manual";
  import ArrowLeftRightIcon from "@lucide/svelte/icons/arrow-left-right";
  import LinkIcon from "@lucide/svelte/icons/link";
  import UnlinkIcon from "@lucide/svelte/icons/unlink";
  import type { PageData } from "./$types";

  const prefs = usePreferences();

  type Tx = PageData["transactions"]["items"][number];

  let { transaction }: { transaction: Tx } = $props();

  const uid = $props.id();
  let unlinking = $state(false);
  let unlinkErrors = $state<NonNullable<FormErrors>>({});
  let loading = $state(false);
  let pickerOpen = $state(false);
  let candidates = $state<TransferCandidate[] | null>(null);
  let loadErrors = $state<NonNullable<FormErrors>>({});
  let linking = $state(false);
  let linkErrors = $state<NonNullable<FormErrors>>({});
  let candidatesForm = $state<HTMLFormElement | null>(null);

  const transfer = $derived(transaction.transfer);
  const mirror = $derived(transaction.source === "mirror");

  function openPicker() {
    pickerOpen = true;
    candidates = null;
    candidatesForm?.requestSubmit();
  }

  function daysLabel(days: number) {
    return days === 0 ? "same day" : `${plural(days, "day")} apart`;
  }
</script>

<section class="grid gap-3 rounded-lg border p-3" aria-labelledby="{uid}-title">
  <h3 id="{uid}-title" class="flex items-center gap-2 text-sm font-medium">
    <ArrowLeftRightIcon class="size-4" aria-hidden="true" />
    Transfer
  </h3>

  {#if transfer}
    <p class="text-sm">
      {transfer.direction === "out" ? "To" : "From"}
      <a
        href={resolve("/(app)/accounts/[id]", { id: transfer.peerAccountId })}
        class="font-medium underline-offset-2 hover:underline"
      >
        {transfer.peerAccountName}
      </a>
      {#if transfer.status === "needs_amount"}
        <Badge
          variant="outline"
          class="ms-1 border-amber-500/50 text-amber-700 dark:text-amber-400"
        >
          needs amount
        </Badge>
      {/if}
    </p>
    <p class="text-muted-foreground text-xs">
      {#if transfer.status === "needs_amount"}
        The other account is in another currency. Enter the amount it booked in
        the needs amount list on that account.
      {:else if transfer.method === "mirrored"}
        {mirror
          ? "Kept created this transaction from the transfer on that account."
          : "Kept created the other side on that account."}
      {:else if transfer.method === "manual"}
        Linked by hand. It does not count as income or expense.
      {:else}
        Matched with a transaction on that account. It does not count as income
        or expense.
      {/if}
    </p>
    {#if !mirror}
      <form
        method="POST"
        action="?/unlinkTransfer"
        class="grid gap-2"
        use:enhance={submitHandler({
          setPending: (v) => (unlinking = v),
          setErrors: (e) => (unlinkErrors = e),
          successMessage: "Transfer unlinked",
        })}
      >
        <input type="hidden" name="transactionId" value={transaction.id} />
        <div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={unlinking}
          >
            {#if unlinking}<Spinner />{:else}<UnlinkIcon />{/if}
            Unlink transfer
          </Button>
        </div>
        {#if unlinkErrors.form?.length}
          <p class="text-destructive text-sm" role="alert">
            {unlinkErrors.form.join(" ")}
          </p>
        {/if}
      </form>
    {/if}
  {:else if !mirror}
    <p class="text-muted-foreground text-xs">
      Not linked. If this is a payment between two of your accounts, link it to
      the other side so it does not count as income or expense.
    </p>
    <form
      method="POST"
      action="?/transferCandidates"
      bind:this={candidatesForm}
      class="hidden"
      use:enhance={submitHandler({
        setPending: (v) => (loading = v),
        setErrors: (e) => (loadErrors = e),
        onSuccessData: (data) => {
          candidates = (data?.candidates as TransferCandidate[]) ?? [];
        },
      })}
    >
      <input type="hidden" name="transactionId" value={transaction.id} />
    </form>
    {#if !pickerOpen}
      <div>
        <Button type="button" variant="outline" size="sm" onclick={openPicker}>
          <LinkIcon /> Link as transfer…
        </Button>
      </div>
    {:else}
      <div class="grid gap-2">
        <div class="flex items-center justify-between gap-2">
          <p class="text-sm font-medium">Pick the other side</p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onclick={() => (pickerOpen = false)}>Cancel</Button
          >
        </div>
        {#if loading || (candidates === null && !loadErrors.form?.length)}
          <p
            class="text-muted-foreground flex items-center gap-2 text-sm"
            role="status"
          >
            <Spinner /> Looking for matches…
          </p>
        {:else if loadErrors.form?.length}
          <p class="text-destructive text-sm" role="alert">
            {loadErrors.form.join(" ")}
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onclick={openPicker}>Try again</Button
            >
          </div>
        {:else if candidates && candidates.length === 0}
          <p class="text-muted-foreground text-sm">
            No transaction in your other accounts is within ten days with the
            opposite sign and is not already linked.
          </p>
        {:else if candidates}
          {#if linkErrors.form?.length}
            <p class="text-destructive text-sm" role="alert">
              {linkErrors.form.join(" ")}
            </p>
          {/if}
          <ul class="divide-y rounded-md border">
            {#each candidates as c (c.id)}
              <li>
                <form
                  method="POST"
                  action="?/linkTransfer"
                  use:enhance={submitHandler({
                    setPending: (v) => (linking = v),
                    setErrors: (e) => (linkErrors = e),
                    successMessage: "Transfer linked",
                    onSuccess: () => (pickerOpen = false),
                  })}
                >
                  <input
                    type="hidden"
                    name="transactionId"
                    value={transaction.id}
                  />
                  <input type="hidden" name="peerId" value={c.id} />
                  <button
                    type="submit"
                    disabled={linking}
                    class="hover:bg-muted/50 focus-visible:ring-ring/50 grid w-full gap-0.5 p-2.5 text-start text-sm outline-none focus-visible:ring-[3px] disabled:opacity-50"
                  >
                    <span class="flex items-start justify-between gap-3">
                      <span class="min-w-0 font-medium break-words">
                        {c.accountName}
                      </span>
                      <Amount
                        value={c.amount}
                        currency={c.currency}
                        flow
                        class="shrink-0"
                      />
                    </span>
                    {#if c.counterpartyName ?? c.description}
                      <span class="text-muted-foreground truncate text-xs">
                        {c.counterpartyName ?? c.description}
                      </span>
                    {/if}
                    <span
                      class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                    >
                      <span>{prefs.date(c.bookingDate)}</span>
                      <span>{daysLabel(c.days)}</span>
                      {#if c.exact}
                        <Badge variant="secondary">same amount</Badge>
                      {/if}
                    </span>
                  </button>
                </form>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {:else}
    <p class="text-muted-foreground text-xs">
      This mirrored transaction has no source any more.
    </p>
  {/if}
</section>
