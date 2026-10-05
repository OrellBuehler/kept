<script lang="ts">
  import PageHeader from "$lib/components/app/page-header.svelte";
  import { resolve } from "$app/paths";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import Amount from "$lib/components/Amount.svelte";
  import { PILLAR_3A_CURRENCY } from "$lib/pillar-3a";
  import { usePreferences } from "$lib/preferences.svelte";
  import LockIcon from "@lucide/svelte/icons/lock";
  import PiggyBankIcon from "@lucide/svelte/icons/piggy-bank";
  import BriefcaseIcon from "@lucide/svelte/icons/briefcase-business";
  import ContributionsCard from "./ContributionsCard.svelte";
  import OrphanAnnotationsCard from "./OrphanAnnotationsCard.svelte";
  import YearsCard from "./YearsCard.svelte";
  import type { PageProps } from "./$types";

  const prefs = usePreferences();
  const currency = PILLAR_3A_CURRENCY;

  let { data }: PageProps = $props();

  const overview = $derived(data.overview);
  const thisYear = $derived(Number(data.today.slice(0, 4)));
  const open = $derived(overview.portfolios.filter((p) => p.closedOn === null));
  const closed = $derived(
    overview.portfolios.filter((p) => p.closedOn !== null),
  );
</script>

<svelte:head>
  <title>Pillar 3a · Kept</title>
</svelte:head>

<div class="grid grid-cols-[minmax(0,1fr)] gap-6">
  <PageHeader
    title="Pillar 3a"
    description="Contributions, yearly limits, buy-ins and the value of your pillar 3a portfolios."
  />

  {#if data.accounts.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><PiggyBankIcon /></Empty.Media>
        <Empty.Title>No Pillar 3a account yet</Empty.Title>
        <Empty.Description>
          Create an account of type Pillar 3a, with your contract number and the
          IBAN you pay into, then add its portfolios.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button href={resolve("/(app)/accounts")}>Go to accounts</Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <div class="grid gap-4 sm:grid-cols-3">
      <Card.Root>
        <Card.Header>
          <Card.Description>Value</Card.Description>
          <Card.Title class="text-xl">
            <Amount value={overview.totals.value} {currency} />
          </Card.Title>
        </Card.Header>
      </Card.Root>
      <Card.Root>
        <Card.Header>
          <Card.Description>Contributed</Card.Description>
          <Card.Title class="text-xl">
            <Amount value={overview.totals.contributed} {currency} />
          </Card.Title>
        </Card.Header>
      </Card.Root>
      <Card.Root>
        <Card.Header>
          <Card.Description>Gain</Card.Description>
          <Card.Title class="text-xl">
            <Amount value={overview.totals.gain} {currency} flow />
          </Card.Title>
        </Card.Header>
      </Card.Root>
    </div>
    <p class="text-muted-foreground -mt-3 flex items-center gap-1.5 text-xs">
      <LockIcon class="size-3.5 shrink-0" />
      Locked until withdrawal, and not subject to wealth tax. Open portfolios only.
    </p>

    <YearsCard years={overview.years} {thisYear} />

    <Card.Root>
      <Card.Header>
        <Card.Title>Portfolios</Card.Title>
        <Card.Description>
          Values are entered by hand on the account page.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if overview.portfolios.length === 0}
          <Empty.Root class="border border-dashed">
            <Empty.Header>
              <Empty.Media variant="icon"><BriefcaseIcon /></Empty.Media>
              <Empty.Title>No portfolios</Empty.Title>
              <Empty.Description>
                Open your Pillar 3a account and add its portfolios.
              </Empty.Description>
            </Empty.Header>
            <Empty.Content>
              {#each data.accounts as a (a.id)}
                <Button
                  size="sm"
                  href={resolve("/(app)/accounts/[id]", { id: a.id })}
                >
                  {a.name}
                </Button>
              {/each}
            </Empty.Content>
          </Empty.Root>
        {:else}
          <ul class="divide-y">
            {#each [...open, ...closed] as p (p.portfolioId)}
              <li
                class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3"
              >
                <div class="grid min-w-0 gap-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <a
                      href={resolve("/(app)/accounts/[id]", {
                        id: p.accountId,
                      })}
                      class="font-medium break-words underline-offset-4 hover:underline"
                    >
                      {p.name}
                    </a>
                    {#if p.closedOn}
                      <Badge variant="outline">
                        <LockIcon /> Closed {prefs.date(p.closedOn)}
                      </Badge>
                    {/if}
                  </div>
                  <div class="text-muted-foreground text-sm break-words">
                    {[p.accountName, p.strategy].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <dl class="grid gap-0.5 text-end text-sm">
                  <div class="flex justify-end gap-2">
                    <dt class="text-muted-foreground">Value</dt>
                    <dd>
                      {#if p.latestValue !== null}
                        <Amount value={p.latestValue} {currency} />
                      {:else}
                        <span class="text-muted-foreground">none yet</span>
                      {/if}
                    </dd>
                  </div>
                  {#if p.latestValueDate}
                    <div class="text-muted-foreground text-xs">
                      as of {prefs.date(p.latestValueDate)}
                    </div>
                  {/if}
                  <div class="flex justify-end gap-2">
                    <dt class="text-muted-foreground">Contributed</dt>
                    <dd><Amount value={p.contributed} {currency} /></dd>
                  </div>
                  {#if p.gain !== null}
                    <div class="flex justify-end gap-2">
                      <dt class="text-muted-foreground">Gain</dt>
                      <dd><Amount value={p.gain} {currency} flow /></dd>
                    </div>
                  {/if}
                </dl>
              </li>
            {/each}
          </ul>
        {/if}
      </Card.Content>
    </Card.Root>

    <ContributionsCard
      contributions={data.contributions}
      portfolios={overview.portfolios}
      gaps={overview.gaps}
    />

    <OrphanAnnotationsCard orphans={overview.orphanAnnotations} />
  {/if}
</div>
