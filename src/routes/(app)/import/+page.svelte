<script lang="ts">
  import InstitutionLogo from "$lib/components/InstitutionLogo.svelte";
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import { untrack } from "svelte";
  import FileIcon from "@lucide/svelte/icons/file-text";
  import LandmarkIcon from "@lucide/svelte/icons/landmark";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import UploadIcon from "@lucide/svelte/icons/upload";
  import XIcon from "@lucide/svelte/icons/x";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import * as Card from "$lib/components/ui/card";
  import * as Empty from "$lib/components/ui/empty";
  import { NativeSelect } from "$lib/components/ui/native-select";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import ImportSteps from "$lib/components/import/ImportSteps.svelte";
  import LocalTime from "$lib/components/import/LocalTime.svelte";
  import { submitHandler } from "$lib/form-submit";
  import { formError } from "$lib/form-errors";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import { MAX_UPLOAD_BYTES } from "$lib/import-constants";
  import {
    FORMAT_LABELS,
    formatBytes,
    formatPeriod,
    plural,
  } from "$lib/import-ui";
  import { cn } from "$lib/utils";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let accountId = $state(
    untrack(
      () =>
        data.selectedAccountId ??
        (form?.values?.accountId as string | undefined) ??
        (data.accounts.length === 1 ? data.accounts[0]!.id : ""),
    ),
  );
  let file = $state<File | null>(null);
  let dragging = $state(false);
  let pending = $state(false);
  let errors = $state<Record<string, string[]>>(
    untrack(() => form?.errors ?? {}),
  );
  let clientFileError = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);

  const fileErrors = $derived(
    clientFileError ? [clientFileError] : errors.file,
  );

  function setFile(next: File | null) {
    errors = { ...errors, file: [] };
    if (next && next.size > MAX_UPLOAD_BYTES) {
      clientFileError = `This file is ${formatBytes(next.size)}; the limit is 20 MB.`;
      file = null;
      if (fileInput) fileInput.value = "";
      return;
    }
    clientFileError = null;
    file = next;
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    const dropped = event.dataTransfer?.files[0];
    if (!dropped || !fileInput) return;
    const transfer = new DataTransfer();
    transfer.items.add(dropped);
    fileInput.files = transfer.files;
    setFile(dropped);
  }

  function clearFile() {
    if (fileInput) fileInput.value = "";
    setFile(null);
  }

  const selectedAccount = $derived(
    data.accounts.find((a) => a.id === accountId) ?? null,
  );

  const enhanceUpload = submitHandler({
    setPending: (v) => (pending = v),
    setErrors: (e) => (errors = e),
    knownFields: ["accountId", "file"],
  });
</script>

<svelte:head>
  <title>Import · Kept</title>
</svelte:head>

<div class="grid max-w-4xl gap-6">
  <div class="grid gap-3">
    <h1 class="text-2xl font-semibold tracking-tight md:text-3xl">
      Import transactions
    </h1>
    <ImportSteps current={accountId ? 2 : 1} />
  </div>

  {#if data.accounts.length === 0}
    <Empty.Root class="border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><LandmarkIcon /></Empty.Media>
        <Empty.Title>No accounts to import into</Empty.Title>
        <Empty.Description>
          Create an account first, then upload a statement for it.
        </Empty.Description>
      </Empty.Header>
      <Empty.Content>
        <Button href={resolve("/accounts")}>Go to accounts</Button>
      </Empty.Content>
    </Empty.Root>
  {:else}
    <Card.Root>
      <Card.Header>
        <Card.Title>Upload a statement</Card.Title>
        <Card.Description>
          ISO 20022 camt.053 XML, CSV or Excel exports. For CSV and Excel you
          map the columns once per account; the mapping is remembered.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <form
          method="POST"
          action="?/upload"
          enctype="multipart/form-data"
          class="grid gap-5"
          use:enhance={(input) => {
            if (!file) {
              clientFileError ??= "Choose a file to upload.";
              input.cancel();
              return;
            }
            return enhanceUpload(input);
          }}
        >
          <FormAlert message={formError(errors)} />

          <FormField
            label="Account"
            for="import-account"
            errors={errors.accountId}
            class="max-w-md"
          >
            <div class="flex items-center gap-2">
              {#if selectedAccount?.institution}
                <InstitutionLogo
                  institution={selectedAccount.institution}
                  size="md"
                />
              {/if}
              <NativeSelect
                id="import-account"
                name="accountId"
                bind:value={accountId}
                class="w-full"
                required
                disabled={pending}
                aria-invalid={!!errors.accountId?.length}
              >
                <option value="" disabled>Choose an account</option>
                {#each data.accounts as account (account.id)}
                  <option value={account.id}>
                    {account.name} ({account.currency}){account.institutionName
                      ? ` · ${account.institutionName}`
                      : ""}
                  </option>
                {/each}
              </NativeSelect>
            </div>
          </FormField>

          <FormField
            label="File"
            for="import-file"
            errors={fileErrors}
            hint="Accepted: .xml, .csv, .txt, .xlsx, up to 20 MB."
          >
            <div
              role="group"
              aria-label="File drop zone"
              class={cn(
                "flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors",
                dragging ? "border-primary bg-primary/5" : "border-input",
                fileErrors?.length && "border-destructive/60",
              )}
              ondragover={(e) => {
                e.preventDefault();
                dragging = true;
              }}
              ondragleave={() => (dragging = false)}
              ondrop={onDrop}
            >
              {#if file}
                <div
                  class="bg-muted flex w-full max-w-sm items-center gap-3 rounded-md px-3 py-2 text-start"
                >
                  <FileIcon class="text-muted-foreground size-5 shrink-0" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium">{file.name}</div>
                    <div class="text-muted-foreground text-xs tabular-nums">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onclick={clearFile}
                    aria-label="Remove file"
                    disabled={pending}
                  >
                    <XIcon />
                  </Button>
                </div>
              {:else}
                <UploadIcon class="text-muted-foreground size-8" />
                <p class="text-sm">
                  Drag a file here, or
                  <button
                    type="button"
                    class="text-primary font-medium underline underline-offset-4"
                    onclick={() => fileInput?.click()}>browse</button
                  >
                </p>
              {/if}
              <input
                bind:this={fileInput}
                id="import-file"
                name="file"
                type="file"
                accept=".xml,.csv,.txt,.xlsx"
                class="sr-only"
                tabindex={-1}
                onchange={(e) => setFile(e.currentTarget.files?.[0] ?? null)}
              />
            </div>
          </FormField>

          <div class="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending || !accountId}>
              {#if pending}<Spinner />Uploading…{:else}<UploadIcon />Upload and
                review{/if}
            </Button>
            {#if selectedAccount}
              <span class="text-muted-foreground text-sm">
                Importing into {selectedAccount.name}
              </span>
            {/if}
          </div>
        </form>
      </Card.Content>
    </Card.Root>
  {/if}

  {#if data.inbox.enabled}
    <section class="grid gap-3" aria-labelledby="inbox-heading">
      <h2 id="inbox-heading" class="text-lg font-semibold">Watch folder</h2>
      <p class="text-muted-foreground text-sm">
        Files dropped into your inbox folder are imported automatically when
        they match one of your accounts and the preview has no warnings.
        {#if data.inbox.lastScan}
          Last scan: <LocalTime
            ms={data.inbox.lastScan.at}
            class="text-foreground"
          />.
        {:else}
          No scan has run yet.
        {/if}
      </p>
      {#if data.inbox.entries.length === 0}
        <p
          class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm"
        >
          Nothing picked up from the inbox yet.
        </p>
      {:else}
        <ul class="divide-y rounded-lg border">
          {#each data.inbox.entries as entry (entry.id)}
            <li class="grid gap-1 px-4 py-3 text-sm">
              <div
                class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
              >
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate font-medium">{entry.fileName}</span>
                  <Badge
                    variant="outline"
                    class={cn(
                      entry.status === "failed" &&
                        "border-destructive/50 text-destructive",
                      entry.status === "review" &&
                        "border-amber-500/50 text-amber-700 dark:text-amber-400",
                    )}
                  >
                    {entry.status === "imported"
                      ? "Imported"
                      : entry.status === "review"
                        ? "Needs review"
                        : entry.status === "failed"
                          ? "Failed"
                          : "Already imported"}
                  </Badge>
                </div>
                <LocalTime
                  ms={entry.updatedAt}
                  class="text-muted-foreground text-xs"
                />
              </div>
              <div
                class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1"
              >
                {#if entry.accountName}<span>{entry.accountName}</span>{/if}
                {#if entry.status === "imported"}
                  <span class="tabular-nums"
                    >{entry.newCount ?? 0} new · {entry.duplicateCount ?? 0} duplicate</span
                  >
                {:else if entry.reason}
                  <span>{entry.reason}</span>
                {/if}
                {#if entry.status === "review"}
                  <form method="POST" action="?/reviewInbox" class="sm:ms-auto">
                    <input type="hidden" name="entryId" value={entry.id} />
                    <Button type="submit" size="sm" variant="outline"
                      >Review</Button
                    >
                  </form>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <section class="grid gap-3" aria-labelledby="recent-heading">
    <h2 id="recent-heading" class="text-lg font-semibold">Recent imports</h2>
    {#if data.recentImports.length === 0}
      <p
        class="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm"
      >
        No imports yet. Completed imports show up here.
      </p>
    {:else}
      <ul class="divide-y rounded-lg border">
        {#each data.recentImports as imp (imp.id)}
          <li class="grid gap-1 px-4 py-3 text-sm">
            <div
              class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
            >
              <div class="flex min-w-0 items-center gap-2">
                <span class="truncate font-medium">{imp.fileName}</span>
                <Badge variant="outline">{FORMAT_LABELS[imp.format]}</Badge>
                {#if imp.warnings.length > 0}
                  <Badge
                    variant="outline"
                    class="border-amber-500/50 text-amber-700 dark:text-amber-400"
                  >
                    <TriangleAlertIcon />{plural(
                      imp.warnings.length,
                      "warning",
                    )}
                  </Badge>
                {/if}
              </div>
              <LocalTime
                ms={imp.createdAt}
                class="text-muted-foreground text-xs"
              />
            </div>
            <div
              class="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1"
            >
              <span>{imp.accountName}</span>
              <span>{formatPeriod(imp.statementFrom, imp.statementTo)}</span>
              <span class="tabular-nums"
                >{imp.newCount} new · {imp.duplicateCount} duplicate</span
              >
              <a
                class="text-foreground underline underline-offset-4 sm:ms-auto"
                href={resolve("/(app)/accounts/[id]/imports", {
                  id: imp.accountId,
                })}>History</a
              >
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
