<script lang="ts">
  import PageHeader from "$lib/components/app/page-header.svelte";
  import { enhance } from "$app/forms";
  import DownloadIcon from "@lucide/svelte/icons/download";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Table from "$lib/components/ui/table/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import { fieldErrors, formError, hasError } from "$lib/form-errors";
  import LocalTime from "$lib/components/app/local-time.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let downloading = $state(false);

  const formatSize = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
</script>

<svelte:head>
  <title>Backup · Kept</title>
</svelte:head>

<PageHeader title="Backup" class="mb-6" />

<div class="grid max-w-3xl grid-cols-[minmax(0,1fr)] gap-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Download a backup</Card.Title>
      <Card.Description>
        A consistent copy of the whole database: accounts, transactions, bills,
        users and settings. Uploaded bill PDFs are stored next to the database
        and are not included, so back up the data volume as well. Keep the
        download safe, it contains all your financial data.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <form
        method="POST"
        action="?/download"
        class="flex max-w-sm flex-col gap-3"
        use:enhance={() => {
          downloading = true;
          return async ({ result, update }) => {
            if (result.type === "success" && result.data?.downloadUrl) {
              window.location.assign(String(result.data.downloadUrl));
              downloading = false;
              await update({ reset: true });
              return;
            }
            await update();
            downloading = false;
          };
        }}
      >
        <FormAlert message={formError(form?.errors)} />
        <Field.Field>
          <Field.Label for="backup-password">Your password</Field.Label>
          <Input
            id="backup-password"
            name="adminPassword"
            type="password"
            autocomplete="current-password"
            required
            aria-invalid={hasError(form?.errors, "adminPassword")}
          />
          <Field.Description>
            Confirm it is you before downloading the database.
          </Field.Description>
          <Field.Error errors={fieldErrors(form?.errors, "adminPassword")} />
        </Field.Field>
        <Button type="submit" class="self-start" disabled={downloading}>
          {#if downloading}<Spinner />{:else}<DownloadIcon />{/if}
          Download backup
        </Button>
      </form>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Scheduled backups</Card.Title>
      <Card.Description>
        {#if data.scheduled}
          A backup is written to <code class="font-mono text-xs"
            >{data.scheduled.dir}</code
          >
          once a day. The newest {data.scheduled.keep} are kept.
        {:else}
          Off. Set <code class="font-mono text-xs">KEPT_BACKUP_DIR</code> (and
          optionally
          <code class="font-mono text-xs">KEPT_BACKUP_KEEP</code>, default 7)
          and restart Kept to write a daily backup.
        {/if}
      </Card.Description>
    </Card.Header>
    {#if data.scheduled}
      <Card.Content>
        {#if data.scheduled.backups.length === 0}
          <p
            class="text-muted-foreground rounded-md border border-dashed p-4 text-sm"
          >
            No backups yet. The first one is written shortly after start.
          </p>
        {:else}
          <Table.Root>
            <Table.Header>
              <Table.Row>
                <Table.Head>File</Table.Head>
                <Table.Head class="text-end">Size</Table.Head>
                <Table.Head class="text-end">Created</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each data.scheduled.backups as backup (backup.name)}
                <Table.Row>
                  <Table.Cell class="font-mono text-xs"
                    >{backup.name}</Table.Cell
                  >
                  <Table.Cell class="text-end tabular-nums"
                    >{formatSize(backup.size)}</Table.Cell
                  >
                  <Table.Cell class="text-end text-xs whitespace-nowrap">
                    <LocalTime ms={backup.createdAt} />
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table.Root>
        {/if}
      </Card.Content>
    {/if}
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Restore</Card.Title>
      <Card.Description>
        Restoring replaces the database file while Kept is stopped, so it is
        done on the server. See the README section "Backup and restore".
      </Card.Description>
    </Card.Header>
  </Card.Root>
</div>
