<script lang="ts">
  import { enhance } from "$app/forms";
  import { toast } from "svelte-sonner";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import LocalTime from "$lib/components/app/local-time.svelte";
  import { formError, type FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import type { refreshPrices } from "$lib/server/investments";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  let savePending = $state(false);
  let saveErrors = $state<NonNullable<FormErrors>>({});
  let refreshPending = $state(false);
  let refreshErrors = $state<NonNullable<FormErrors>>({});

  type RefreshResult = Awaited<ReturnType<typeof refreshPrices>>;

  function summary(r: RefreshResult) {
    const parts = [
      `${r.securities} ${r.securities === 1 ? "security" : "securities"}`,
      `${r.fxPairs} currency ${r.fxPairs === 1 ? "pair" : "pairs"}`,
    ];
    return `Updated ${parts.join(" and ")} (${r.prices} prices, ${r.fxRates} rates).`;
  }
</script>

<div class="grid grid-cols-[minmax(0,1fr)] gap-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Market data</Card.Title>
      <Card.Description>
        Kept can fetch daily closing prices for your securities and the exchange
        rates between their currency and your account's currency. It is off
        until you turn it on. Without it, you enter prices by hand.
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-5">
      <form
        method="POST"
        action="?/save"
        class="grid gap-4"
        use:enhance={submitHandler({
          setPending: (v) => (savePending = v),
          setErrors: (e) => (saveErrors = e),
          successMessage: "Market data settings saved.",
        })}
      >
        <FormAlert message={formError(saveErrors)} />
        <div class="flex items-center gap-3">
          <Switch id="enabled" name="enabled" checked={data.settings.enabled} />
          <Label for="enabled">Fetch prices from Yahoo Finance</Label>
        </div>
        {#if !data.providerAvailable}
          <p class="text-muted-foreground text-sm">
            No market data provider is available in this installation.
          </p>
        {/if}
        <div class="text-muted-foreground grid gap-2 text-sm">
          <p>What leaves your server when this is on:</p>
          <ul class="list-disc ps-5">
            <li>
              The ticker symbols of your securities (for example
              <span class="font-mono">VWRL.SW</span>) and currency pairs (for
              example <span class="font-mono">USDCHF=X</span>), with a date
              range.
            </li>
            <li>
              The text you type when you look up a security by ISIN or name.
            </li>
            <li>
              Yahoo Finance also sees your server's IP address, as with any web
              request.
            </li>
          </ul>
          <p>
            Quantities, amounts, trades, account names, transactions and
            balances are never sent. Prices are fetched about every six hours.
          </p>
        </div>
        <Button type="submit" class="w-fit" disabled={savePending}>
          {#if savePending}<Spinner />{/if}
          Save
        </Button>
      </form>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Refresh</Card.Title>
      <Card.Description>
        Fetch prices and rates now instead of waiting for the next scheduled
        run.
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-4">
      <dl class="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
        <dt class="text-muted-foreground">Last run</dt>
        <dd>
          {#if data.settings.lastRunAt !== null}
            <LocalTime ms={data.settings.lastRunAt} />
          {:else}
            Never
          {/if}
        </dd>
        <dt class="text-muted-foreground">Last error</dt>
        <dd class="break-words">
          {#if data.settings.lastError}
            <span class="text-destructive">{data.settings.lastError}</span>
          {:else}
            None
          {/if}
        </dd>
      </dl>
      <form
        method="POST"
        action="?/refresh"
        class="grid gap-4"
        use:enhance={(input) => {
          const handle = submitHandler({
            setPending: (v) => (refreshPending = v),
            setErrors: (e) => (refreshErrors = e),
          })(input);
          return async (args) => {
            if (args.result.type === "success") {
              const r = args.result.data?.result as RefreshResult;
              if (r.errors.length > 0) {
                toast.warning(
                  `${summary(r)} ${r.errors.length} ${r.errors.length === 1 ? "request" : "requests"} failed, see Last error.`,
                );
              } else {
                toast.success(summary(r));
              }
            }
            const callback = await handle;
            await callback?.(args);
          };
        }}
      >
        <FormAlert message={formError(refreshErrors)} />
        <Button
          type="submit"
          variant="outline"
          class="w-fit"
          disabled={refreshPending ||
            !data.settings.enabled ||
            !data.providerAvailable}
        >
          {#if refreshPending}
            <Spinner />Refreshing…
          {:else}
            <RefreshCwIcon />Refresh now
          {/if}
        </Button>
        {#if !data.settings.enabled}
          <p class="text-muted-foreground text-xs">
            Turn on market data above first.
          </p>
        {/if}
      </form>
    </Card.Content>
  </Card.Root>
</div>
