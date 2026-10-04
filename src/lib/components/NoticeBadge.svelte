<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import Amount from "$lib/components/Amount.svelte";
  import type { WithdrawalPeriod } from "$lib/ledger-types";
  import type { Minor } from "$lib/money";
  import ClockIcon from "@lucide/svelte/icons/clock";

  let {
    noticeMonths,
    freeWithdrawal = null,
    freeWithdrawalPeriod = null,
    currency,
    class: className,
  }: {
    noticeMonths: number | null;
    freeWithdrawal?: Minor | null;
    freeWithdrawalPeriod?: WithdrawalPeriod | null;
    currency: string;
    class?: string;
  } = $props();
</script>

{#if noticeMonths !== null}
  <Badge variant="outline" class={className}>
    <ClockIcon class="size-3" aria-hidden="true" />
    <span>
      {noticeMonths}
      {noticeMonths === 1 ? "month's" : "months'"} notice
      {#if freeWithdrawal !== null && freeWithdrawalPeriod !== null}
        · <Amount value={freeWithdrawal} {currency} />/{freeWithdrawalPeriod} free
      {/if}
    </span>
  </Badge>
{/if}
