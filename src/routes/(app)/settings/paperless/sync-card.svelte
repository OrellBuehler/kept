<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import LocalTime from "$lib/components/app/local-time.svelte";
  import { cn } from "$lib/utils";
  import { formError, type FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import type { syncConnection } from "$lib/server/integrations/paperless/sync";
  import type { PageData } from "./$types";

  type Connection = NonNullable<PageData["connection"]>;

  let {
    connection,
    documents,
    uploads,
    syncResult,
  }: {
    connection: Connection;
    documents: PageData["recentDocuments"];
    uploads: PageData["uploads"];
    syncResult: Awaited<ReturnType<typeof syncConnection>> | null;
  } = $props();

  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});

  const counts = $derived(
    syncResult
      ? ([
          ["Listed", syncResult.listed],
          ["Imported", syncResult.imported],
          ["Updated", syncResult.updated],
          ["Unchanged", syncResult.unchanged],
          ["Skipped", syncResult.skipped],
          ["Failed", syncResult.failed],
          ["Missing", syncResult.missing],
        ] as const)
      : [],
  );

  const DOC_STATUS = {
    imported:
      "border-transparent bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-300",
    skipped: "border-border bg-secondary text-secondary-foreground",
    failed:
      "border-transparent bg-red-100 text-red-900 dark:bg-red-400/15 dark:text-red-300",
  } as const;

  const UPLOAD_STATUS = {
    success: DOC_STATUS.imported,
    pending:
      "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-300",
    failed: DOC_STATUS.failed,
  } as const;

  const REPORT_KINDS: Record<string, string> = {
    statement: "Account statement",
    bills: "Bills overview",
    "net-worth": "Net worth",
  };
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Sync</Card.Title>
    <Card.Description>
      Look for new and changed documents now, and push bill values back to
      Paperless.
    </Card.Description>
  </Card.Header>
  <Card.Content class="grid grid-cols-[minmax(0,1fr)] gap-6">
    <form
      method="POST"
      action="?/syncNow"
      class="grid grid-cols-[minmax(0,1fr)] gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        successMessage: "Sync finished.",
      })}
    >
      <FormAlert message={formError(errors)} />
      <Button
        type="submit"
        disabled={pending || !connection.enabled || !connection.billSource}
        class="self-start"
      >
        {#if pending}<Spinner />Syncing…{:else}<RefreshCwIcon />Sync now{/if}
      </Button>
      {#if !connection.billSource}
        <p class="text-muted-foreground text-xs">Choose a bill source first.</p>
      {:else if !connection.enabled}
        <p class="text-muted-foreground text-xs">
          Sync is paused. Turn it on under Connection.
        </p>
      {/if}
    </form>

    {#if syncResult}
      <dl
        class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7"
        aria-label="Result of the last sync"
      >
        {#each counts as [label, value] (label)}
          <div class="rounded-md border px-3 py-2">
            <dt class="text-muted-foreground text-xs">{label}</dt>
            <dd class="text-lg font-semibold tabular-nums">{value}</dd>
          </div>
        {/each}
      </dl>
    {/if}

    <section
      class="grid grid-cols-[minmax(0,1fr)] gap-2"
      aria-labelledby="recent-docs-heading"
    >
      <h3 id="recent-docs-heading" class="text-sm font-medium">
        Recent documents
      </h3>
      {#if documents.length === 0}
        <p
          class="text-muted-foreground rounded-md border border-dashed p-4 text-sm"
        >
          No documents yet. Documents appear here after the first sync.
        </p>
      {:else}
        <Table.Root>
          <Table.Header>
            <Table.Row>
              <Table.Head>Document</Table.Head>
              <Table.Head>Status</Table.Head>
              <Table.Head>Bill / problem</Table.Head>
              <Table.Head class="text-end">Updated</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {#each documents as doc (doc.id)}
              <Table.Row>
                <Table.Cell>
                  <a
                    href={doc.paperlessUrl}
                    target="_blank"
                    rel="noopener noreferrer external"
                    class="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                  >
                    #{doc.paperlessId}
                    <ExternalLinkIcon class="size-3" aria-hidden="true" />
                    <span class="sr-only">(opens Paperless in a new tab)</span>
                  </a>
                </Table.Cell>
                <Table.Cell>
                  <Badge variant="outline" class={cn(DOC_STATUS[doc.status])}>
                    {doc.status}
                  </Badge>
                </Table.Cell>
                <Table.Cell class="max-w-[16rem] whitespace-normal">
                  {#if doc.billId}
                    <a
                      href={resolve("/(app)/bills/[id]", { id: doc.billId })}
                      class="underline-offset-4 hover:underline">Open bill</a
                    >
                  {/if}
                  {#if doc.error}
                    <span
                      class="text-muted-foreground block text-xs break-words"
                      >{doc.error}</span
                    >
                  {/if}
                  {#if !doc.billId && !doc.error}
                    <span class="text-muted-foreground">-</span>
                  {/if}
                </Table.Cell>
                <Table.Cell class="text-end text-xs whitespace-nowrap">
                  <LocalTime ms={doc.updatedAt} />
                </Table.Cell>
              </Table.Row>
            {/each}
          </Table.Body>
        </Table.Root>
      {/if}
    </section>

    <section
      class="grid grid-cols-[minmax(0,1fr)] gap-2"
      aria-labelledby="uploads-heading"
    >
      <h3 id="uploads-heading" class="text-sm font-medium">Report uploads</h3>
      {#if uploads.length === 0}
        <p
          class="text-muted-foreground rounded-md border border-dashed p-4 text-sm"
        >
          No reports uploaded yet. Upload a PDF report to Paperless from the
          Reports page.
        </p>
      {:else}
        <ul class="divide-y rounded-md border">
          {#each uploads as upload (upload.id)}
            <li
              class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span class="font-medium"
                >{REPORT_KINDS[upload.reportKind] ?? upload.reportKind}</span
              >
              <Badge variant="outline" class={cn(UPLOAD_STATUS[upload.status])}>
                {upload.status}
              </Badge>
              {#if upload.paperlessDocumentId !== null}
                <a
                  href="{connection.baseUrl}/documents/{upload.paperlessDocumentId}/details"
                  target="_blank"
                  rel="noopener noreferrer external"
                  class="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                >
                  Paperless #{upload.paperlessDocumentId}
                  <ExternalLinkIcon class="size-3" aria-hidden="true" />
                  <span class="sr-only">(opens Paperless in a new tab)</span>
                </a>
              {/if}
              {#if upload.error}
                <span class="text-muted-foreground min-w-0 text-xs break-words"
                  >{upload.error}</span
                >
              {/if}
              <span class="text-muted-foreground ms-auto text-xs">
                <LocalTime ms={upload.createdAt} />
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </Card.Content>
</Card.Root>
