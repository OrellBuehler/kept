<script lang="ts">
  import * as Sheet from "$lib/components/ui/sheet";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import Amount from "$lib/components/Amount.svelte";
  import { formatDate } from "$lib/format";
  import { maskIban } from "$lib/iban";
  import { formatAmount } from "$lib/money";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import TaxYearTag from "./TaxYearTag.svelte";
  import TransactionForm from "./TransactionForm.svelte";
  import type { PageData } from "./$types";

  type Tx = PageData["transactions"]["items"][number];

  let {
    open = $bindable(false),
    transaction,
    currency,
    onDelete,
  }: {
    open?: boolean;
    transaction: Tx | null;
    currency: string;
    onDelete: (tx: Tx) => void;
  } = $props();

  let showIban = $state(false);

  $effect(() => {
    void transaction?.id;
    showIban = false;
  });

  const imported = $derived(transaction?.source === "import");
</script>

<Sheet.Root bind:open>
  <Sheet.Content class="w-full overflow-y-auto sm:max-w-md">
    {#if transaction}
      <Sheet.Header>
        <Sheet.Title class="flex flex-wrap items-center gap-2">
          Transaction
          <Badge variant={imported ? "outline" : "secondary"}>
            {imported ? "imported" : "manual"}
          </Badge>
          {#if transaction.reversal}
            <Badge variant="outline">reversal</Badge>
          {/if}
        </Sheet.Title>
        <Sheet.Description class="flex flex-col gap-1">
          <span>{formatDate(transaction.bookingDate)}</span>
          <Amount
            value={transaction.amount}
            {currency}
            flow
            class="text-foreground text-2xl font-semibold"
          />
        </Sheet.Description>
      </Sheet.Header>

      <div class="grid gap-4 px-4 pb-4">
        {#if imported}
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {#if transaction.valueDate}
              <dt class="text-muted-foreground">Value date</dt>
              <dd>{formatDate(transaction.valueDate)}</dd>
            {/if}
            {#if transaction.counterpartyName}
              <dt class="text-muted-foreground">Counterparty</dt>
              <dd class="break-words">{transaction.counterpartyName}</dd>
            {/if}
            {#if transaction.counterpartyIban}
              <dt class="text-muted-foreground">IBAN</dt>
              <dd class="flex items-center gap-2">
                <span class="font-mono break-all">
                  {showIban
                    ? transaction.counterpartyIban
                    : maskIban(transaction.counterpartyIban)}
                </span>
                <button
                  type="button"
                  class="text-muted-foreground text-xs underline"
                  onclick={() => (showIban = !showIban)}
                >
                  {showIban ? "hide" : "show"}
                </button>
              </dd>
            {/if}
            {#if transaction.description}
              <dt class="text-muted-foreground">Description</dt>
              <dd class="break-words">{transaction.description}</dd>
            {/if}
            {#if transaction.reference}
              <dt class="text-muted-foreground">Reference</dt>
              <dd class="font-mono break-all">
                {transaction.reference}
                {#if transaction.referenceType}
                  <span class="text-muted-foreground">
                    ({transaction.referenceType})</span
                  >
                {/if}
              </dd>
            {/if}
            {#if transaction.originalAmount !== null && transaction.originalCurrency}
              <dt class="text-muted-foreground">Original</dt>
              <dd class="tabular-nums">
                {formatAmount(
                  transaction.originalAmount,
                  transaction.originalCurrency,
                )}
              </dd>
            {/if}
          </dl>
          <p class="text-muted-foreground text-xs">
            Imported transactions can only have their note changed. Delete the
            import to remove them.
          </p>
        {/if}

        {#key transaction.id}
          <TransactionForm
            action="?/updateTransaction"
            {currency}
            {transaction}
            noteOnly={imported}
            submitLabel="Save"
            successMessage="Transaction updated"
            onSuccess={() => (open = false)}
            onCancel={() => (open = false)}
          />
        {/key}

        {#key transaction.id + ":" + transaction.taxYear}
          <TaxYearTag
            transactionId={transaction.id}
            taxYear={transaction.taxYear}
          />
        {/key}

        {#if !imported}
          <Button
            type="button"
            variant="outline"
            class="text-destructive"
            onclick={() => transaction && onDelete(transaction)}
          >
            <Trash2Icon /> Delete transaction
          </Button>
        {/if}
      </div>
    {/if}
  </Sheet.Content>
</Sheet.Root>
