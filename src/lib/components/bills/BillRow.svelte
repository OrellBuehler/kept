<script lang="ts">
  import { resolve } from "$app/paths";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import Amount from "$lib/components/Amount.svelte";
  import BillStatusBadge from "$lib/components/bills/BillStatusBadge.svelte";
  import { KIND_LABELS, dueHint } from "$lib/bill-display";
  import { formatDate } from "$lib/format";
  import type { BillWithStatus } from "$lib/server/bills/status";
  import { cn } from "$lib/utils";

  let { bill }: { bill: BillWithStatus } = $props();

  const hint = $derived(dueHint(bill));
  const showRemaining = $derived(
    bill.remaining !== null &&
      bill.amount !== null &&
      bill.status === "partially_paid",
  );
  const refundDue = $derived(
    bill.status === "credit_due" || bill.status === "overpaid",
  );
</script>

<li>
  <a
    href={resolve("/(app)/bills/[id]", { id: bill.id })}
    class={cn(
      "hover:bg-muted/50 focus-visible:ring-ring/50 flex items-start justify-between gap-4 border-s-4 border-transparent p-4 outline-none focus-visible:ring-[3px]",
      bill.overdue && "border-s-destructive",
    )}
  >
    <div class="grid min-w-0 gap-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="truncate font-medium">
          {bill.creditorName ?? "Unnamed creditor"}
        </span>
        <BillStatusBadge status={bill.status} />
        {#if bill.kind === "credit_note"}
          <span class="text-muted-foreground text-xs">
            {KIND_LABELS.credit_note}
          </span>
        {/if}
        {#if bill.documentId}
          <FileTextIcon
            class="text-muted-foreground size-4 shrink-0"
            aria-label="PDF attached"
          />
        {/if}
      </div>
      {#if bill.invoiceNumber}
        <span class="text-muted-foreground truncate text-xs">
          No. {bill.invoiceNumber}
        </span>
      {/if}
      <span class="text-xs">
        {#if bill.dueDate}
          <span class="text-muted-foreground">
            Due {formatDate(bill.dueDate)}
          </span>
        {:else}
          <span class="text-muted-foreground">No due date</span>
        {/if}
        {#if hint}
          <span
            class={cn(
              "ms-1 font-medium",
              bill.overdue ? "text-destructive" : "text-foreground",
            )}
          >
            · {hint}
          </span>
        {/if}
      </span>
    </div>
    <div class="grid shrink-0 justify-items-end gap-0.5 text-end">
      {#if bill.amount !== null}
        <Amount
          value={bill.amount}
          currency={bill.currency}
          class="text-lg font-semibold"
        />
      {:else}
        <span class="text-muted-foreground text-sm">Open amount</span>
      {/if}
      {#if showRemaining && bill.remaining !== null}
        <span class="text-muted-foreground text-xs tabular-nums">
          <Amount
            value={bill.remaining}
            currency={bill.currency}
            class="text-xs"
          /> remaining
        </span>
      {:else if refundDue && bill.remaining !== null}
        <span class="text-muted-foreground text-xs">Refund expected</span>
      {/if}
    </div>
  </a>
</li>
