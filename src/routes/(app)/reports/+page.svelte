<script lang="ts">
  import { resolve } from "$app/paths";
  import { untrack } from "svelte";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import FileTextIcon from "@lucide/svelte/icons/file-text";
  import LandmarkIcon from "@lucide/svelte/icons/landmark";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { NativeSelect } from "$lib/components/ui/native-select";
  import { Switch } from "$lib/components/ui/switch";
  import FormField from "$lib/components/FormField.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  function pad(n: number) {
    return String(n).padStart(2, "0");
  }
  function lastFullMonth(today: string) {
    const [y, m] = today.split("-").map(Number) as [number, number];
    const year = m === 1 ? y - 1 : y;
    const month = m === 1 ? 12 : m - 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      from: `${year}-${pad(month)}-01`,
      to: `${year}-${pad(month)}-${pad(lastDay)}`,
    };
  }

  const initial = untrack(() => lastFullMonth(data.today));

  let showArchived = $state(false);
  let accountId = $state("");
  let from = $state(initial.from);
  let to = $state(initial.to);

  const visible = $derived(
    data.accounts.filter((a) => showArchived || !a.archived),
  );
  const selectedVisible = $derived(visible.some((a) => a.id === accountId));
  const rangeInvalid = $derived(from !== "" && to !== "" && from > to);
  const canDownload = $derived(
    selectedVisible && from !== "" && to !== "" && !rangeInvalid,
  );

  $effect(() => {
    if (!selectedVisible) {
      accountId = visible.length === 1 ? visible[0]!.id : "";
    }
  });
</script>

<svelte:head>
  <title>Reports · Kept</title>
</svelte:head>

<div class="mb-6">
  <h1 class="text-2xl font-semibold tracking-tight">Reports</h1>
  <p class="text-muted-foreground mt-1 text-sm">
    Generate PDF reports to keep or share. Once Paperless-ngx is connected in
    <a class="underline underline-offset-2" href={resolve("/settings/account")}
      >settings</a
    >, reports can be sent there as well.
  </p>
</div>

<div class="grid gap-4 lg:grid-cols-2">
  <Card.Root class="lg:col-span-2">
    <Card.Header>
      <Card.Title>Account statement</Card.Title>
      <Card.Description>
        Opening and closing balance and every transaction of one account in a
        period.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      {#if data.accounts.length === 0}
        <Empty.Root class="border border-dashed">
          <Empty.Header>
            <Empty.Media variant="icon"><LandmarkIcon /></Empty.Media>
            <Empty.Title>No accounts yet</Empty.Title>
            <Empty.Description>
              Add an account to generate a statement for it.
            </Empty.Description>
          </Empty.Header>
          <Empty.Content>
            <Button href={resolve("/accounts")}>Go to accounts</Button>
          </Empty.Content>
        </Empty.Root>
      {:else}
        <form
          method="GET"
          action={resolve("/reports/statement")}
          data-sveltekit-reload
          class="grid gap-4 sm:grid-cols-2"
        >
          <FormField label="Account" for="report-account" class="sm:col-span-2">
            <NativeSelect
              id="report-account"
              name="account"
              bind:value={accountId}
              class="w-full"
              required
            >
              <option value="" disabled>Choose an account</option>
              {#each visible as account (account.id)}
                <option value={account.id}>
                  {account.name} ({account.currency}){account.ibanMasked
                    ? ` · ${account.ibanMasked}`
                    : ""}{account.archived ? " · archived" : ""}
                </option>
              {/each}
            </NativeSelect>
          </FormField>
          <div class="flex items-center gap-2 sm:col-span-2">
            <Switch id="report-archived" bind:checked={showArchived} />
            <Label for="report-archived">Show archived accounts</Label>
          </div>
          <FormField label="From" for="report-from">
            <Input
              id="report-from"
              name="from"
              type="date"
              bind:value={from}
              required
              max={to || undefined}
              aria-invalid={rangeInvalid}
            />
          </FormField>
          <FormField
            label="To"
            for="report-to"
            errors={rangeInvalid
              ? ["The end date must not be before the start date."]
              : []}
          >
            <Input
              id="report-to"
              name="to"
              type="date"
              bind:value={to}
              required
              min={from || undefined}
              aria-invalid={rangeInvalid}
            />
          </FormField>
          <div class="sm:col-span-2">
            <Button type="submit" disabled={!canDownload}>
              <DownloadIcon />
              Download PDF
            </Button>
          </div>
        </form>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Bills</Card.Title>
      <Card.Description>
        All bills with their status, amounts and due dates.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Button
        variant="outline"
        href={resolve("/reports/bills")}
        data-sveltekit-reload
        download
      >
        <DownloadIcon />
        Download PDF
      </Button>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Net worth</Card.Title>
      <Card.Description>
        Current balances per account and net worth over time, per currency.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Button
        variant="outline"
        href={resolve("/reports/net-worth")}
        data-sveltekit-reload
        download
      >
        <DownloadIcon />
        Download PDF
      </Button>
    </Card.Content>
  </Card.Root>
</div>

<p class="text-muted-foreground mt-4 flex items-center gap-2 text-xs">
  <FileTextIcon class="size-3.5 shrink-0" />
  Reports reflect the data at the moment you download them.
</p>
