<script lang="ts">
  import { toast } from "svelte-sonner";
  import * as Card from "$lib/components/ui/card/index.js";
  import type { testConnection } from "$lib/server/integrations/paperless/connection";
  import type { WorkflowRecipe } from "$lib/server/integrations/paperless/setup";
  import type { syncConnection } from "$lib/server/integrations/paperless/sync";
  import ConnectionCard from "./connection-card.svelte";
  import ReportCard from "./report-card.svelte";
  import MappingCard from "./mapping-card.svelte";
  import SourceCard from "./source-card.svelte";
  import SyncCard from "./sync-card.svelte";
  import WebhookCard from "./webhook-card.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  // Results arrive once through `form` and are replaced by the next action,
  // so the ones that must stay visible are kept here.
  let secret = $state<{
    value: string;
    from: "save" | "rotateSecret";
    recipe: WorkflowRecipe | null;
  } | null>(null);
  let testResult = $state<Awaited<ReturnType<typeof testConnection>> | null>(
    null,
  );
  let syncResult = $state<Awaited<ReturnType<typeof syncConnection>> | null>(
    null,
  );

  $effect(() => {
    if (!form) return;
    if (form.action === "save" || form.action === "rotateSecret") {
      if ("webhookSecret" in form && form.webhookSecret) {
        secret = {
          value: form.webhookSecret,
          from: form.action,
          recipe: form.recipe ?? null,
        };
      }
    } else if (form.action === "test" && "result" in form) {
      testResult = form.result as typeof testResult;
    } else if (form.action === "syncNow" && "result" in form) {
      syncResult = form.result as typeof syncResult;
    } else if (form.action === "uploadReport" && "upload" in form) {
      if (form.alreadyUploaded) toast.info("Already sent");
      else if (form.upload?.status === "success")
        toast.success("Sent to Paperless");
      else if (form.upload?.status === "pending") toast.info("Upload queued");
      else
        toast.error("Paperless did not accept the report. See the list below.");
    } else if (form.action === "disconnect") {
      secret = null;
      testResult = null;
      syncResult = null;
    }
  });

  const recipe = $derived(secret?.recipe ?? data.recipe);

  const setupSteps = [
    "In Paperless, create a dedicated user and an API token under My Profile. Give it view, change and add on documents, plus view on tags, saved views, custom fields and tasks.",
    "Enter the address and token below and connect. Turn on self-signed certificates only if Paperless needs it.",
    "Copy the webhook secret that is shown once after connecting.",
    "Choose where bills come from: a tag or a saved view.",
    "Optionally map custom fields so Paperless shows the amount, due date, reference and status.",
    "Optionally create the Paperless workflow from the recipe, for instant import.",
    "Press Sync now.",
  ];
</script>

<svelte:head>
  <title>Paperless-ngx settings · Kept</title>
</svelte:head>

<h1 class="mb-2 text-2xl font-semibold tracking-tight">Paperless-ngx</h1>
<p class="text-muted-foreground mb-6 max-w-2xl text-sm">
  An optional integration: Kept works fully without it. When connected, Kept
  pulls bills from a tag or saved view in Paperless, links each bill back to its
  document, writes the amount, due date, reference and status into custom
  fields, and can upload reports as documents. Needs Paperless-ngx {data.minVersion}
  or newer; 2.18 or newer is recommended.
</p>

<div class="grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
  <ConnectionCard
    {data}
    secret={secret?.from === "save" ? secret.value : null}
    {testResult}
    ondismisssecret={() => (secret = null)}
  />

  {#if data.connection}
    {#if data.lookups}
      <SourceCard connection={data.connection} lookups={data.lookups} />
      <MappingCard
        connection={data.connection}
        lookups={data.lookups}
        billStatuses={data.billStatuses}
      />
    {/if}
    {#if data.webhookUrl && recipe}
      <WebhookCard
        webhookUrl={data.webhookUrl}
        {recipe}
        secret={secret?.from === "rotateSecret" ? secret.value : null}
        ondismisssecret={() => (secret = null)}
      />
    {/if}
    <SyncCard
      connection={data.connection}
      documents={data.recentDocuments}
      uploads={data.uploads}
      {syncResult}
    />
    <ReportCard accounts={data.accounts} />
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Title>Setup</Card.Title>
        <Card.Description>
          Nothing is connected yet. These are the steps.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <ol
          class="grid list-decimal grid-cols-[minmax(0,1fr)] gap-2 ps-5 text-sm"
        >
          {#each setupSteps as step (step)}
            <li class="ps-1">{step}</li>
          {/each}
        </ol>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
