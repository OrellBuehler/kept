<script lang="ts">
  import { enhance } from "$app/forms";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import UnplugIcon from "@lucide/svelte/icons/unplug";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import LocalTime from "$lib/components/app/local-time.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import { formError, type FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import type { testConnection } from "$lib/server/integrations/paperless/connection";
  import SecretBox from "./secret-box.svelte";
  import type { PageData } from "./$types";

  let {
    data,
    secret,
    testResult,
    testError,
    ondismisssecret,
  }: {
    data: PageData;
    secret: string | null;
    testResult: Awaited<ReturnType<typeof testConnection>> | null;
    testError: string | null;
    ondismisssecret: () => void;
  } = $props();

  const connection = $derived(data.connection);

  let savePending = $state(false);
  let saveErrors = $state<NonNullable<FormErrors>>({});
  let testPending = $state(false);
  let testErrors = $state<NonNullable<FormErrors>>({});
  let togglePending = $state(false);
  let toggleErrors = $state<NonNullable<FormErrors>>({});
  let disconnectOpen = $state(false);
  let toggleForm = $state<HTMLFormElement | null>(null);
  // Uncontrolled inputs: only the switch needs state, for the warning below it.
  // svelte-ignore state_referenced_locally
  let insecure = $state(data.connection?.allowInsecureTls ?? false);
</script>

<Card.Root>
  <Card.Header>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <Card.Title>Connection</Card.Title>
      {#if connection?.tokenUnreadable}
        <Badge variant="destructive">Needs re-entry</Badge>
      {:else if connection}
        <Badge variant={connection.enabled ? "default" : "secondary"}>
          {connection.enabled ? "Enabled" : "Paused"}
        </Badge>
      {/if}
    </div>
    <Card.Description>
      Paperless-ngx {data.minVersion} or newer; 2.18 or newer is recommended. Use
      a dedicated Paperless user and API token.
    </Card.Description>
  </Card.Header>
  <Card.Content class="grid grid-cols-[minmax(0,1fr)] gap-6">
    {#if secret}
      <SecretBox {secret} ondismiss={ondismisssecret} />
    {/if}

    {#if connection?.tokenUnreadable}
      <FormAlert
        message="The saved API token can no longer be read, probably because KEPT_SECRET_KEY changed. Nothing is synced until you enter the token again and save, or disconnect."
      />
    {/if}

    {#if connection}
      <dl
        class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm"
        aria-label="Connection status"
      >
        <dt class="text-muted-foreground">Server</dt>
        <dd class="min-w-0 break-words">
          {connection.serverVersion
            ? `Paperless-ngx ${connection.serverVersion}`
            : "Not tested yet"}{#if connection.apiVersion}, API v{connection.apiVersion}{/if}
        </dd>
        <dt class="text-muted-foreground">Last sync</dt>
        <dd class="min-w-0">
          {#if data.lastSync?.at}
            <LocalTime ms={data.lastSync.at} />
          {:else}
            <span class="text-muted-foreground">Not synced yet</span>
          {/if}
        </dd>
        {#if data.lastSync?.message}
          <dt class="text-muted-foreground">Problem</dt>
          <dd class="text-destructive min-w-0 break-words">
            {data.lastSync.message}
          </dd>
        {/if}
      </dl>
    {/if}

    <form
      method="POST"
      action="?/save"
      class="grid grid-cols-[minmax(0,1fr)] gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (savePending = v),
        setErrors: (e) => (saveErrors = e),
        knownFields: [
          "baseUrl",
          "token",
          "allowInsecureTls",
          "differentInstance",
        ],
      })}
    >
      <FormAlert message={formError(saveErrors)} />
      <FormField
        label="Address"
        for="baseUrl"
        errors={saveErrors.baseUrl}
        hint="The address you open Paperless at, without /api."
      >
        <Input
          id="baseUrl"
          name="baseUrl"
          type="url"
          inputmode="url"
          autocomplete="off"
          placeholder="https://paperless.example.org"
          required
          value={connection?.baseUrl ?? ""}
          aria-invalid={!!saveErrors.baseUrl}
        />
      </FormField>
      <FormField
        label="API token"
        for="token"
        errors={saveErrors.token}
        hint={connection?.tokenUnreadable
          ? "Enter the token again."
          : connection
            ? "A token is stored. Leave blank to keep it; enter a new one to replace it."
            : "Created under My Profile in Paperless. Stored encrypted, never shown again."}
      >
        <Input
          id="token"
          name="token"
          type="password"
          autocomplete="new-password"
          required={!connection || connection.tokenUnreadable}
          placeholder={connection && !connection.tokenUnreadable
            ? "Unchanged"
            : ""}
          aria-invalid={!!saveErrors.token}
        />
      </FormField>
      {#if connection}
        <div class="grid gap-2">
          <div class="flex items-center gap-3">
            <Switch id="differentInstance" name="differentInstance" />
            <Label for="differentInstance">
              This is a different Paperless server
            </Label>
          </div>
          <p class="text-muted-foreground text-xs">
            Leave off when only the address changed: your bills stay linked to
            their documents. Turn on for another or reinstalled server, whose
            document numbers mean something else; the links are then reset and
            its documents are imported again.
          </p>
        </div>
      {/if}
      <div class="grid gap-2">
        <div class="flex items-center gap-3">
          <Switch
            id="allowInsecureTls"
            name="allowInsecureTls"
            bind:checked={insecure}
          />
          <Label for="allowInsecureTls">Allow self-signed certificates</Label>
        </div>
        {#if insecure}
          <Alert.Root
            class="border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200"
          >
            <TriangleAlertIcon />
            <Alert.Description class="text-amber-900/90 dark:text-amber-200/90">
              Kept will not verify the identity of this server. Anyone on the
              network path could read the token. Use this only for a server on a
              network you trust.
            </Alert.Description>
          </Alert.Root>
        {:else}
          <p class="text-muted-foreground text-xs">
            Only needed when Paperless uses a certificate that is not signed by
            a public authority.
          </p>
        {/if}
      </div>
      <Button type="submit" disabled={savePending} class="self-start">
        {#if savePending}<Spinner />Saving…{:else}{connection
            ? "Save changes"
            : "Connect"}{/if}
      </Button>
    </form>

    {#if connection}
      <div class="grid gap-4 border-t pt-6">
        <div class="flex flex-wrap items-center gap-3">
          <form
            method="POST"
            action="?/test"
            use:enhance={submitHandler({
              setPending: (v) => (testPending = v),
              setErrors: (e) => (testErrors = e),
            })}
          >
            <Button type="submit" variant="outline" disabled={testPending}>
              {#if testPending}<Spinner />Testing…{:else}Test connection{/if}
            </Button>
          </form>
          <form
            method="POST"
            action="?/toggle"
            bind:this={toggleForm}
            class="flex items-center gap-2"
            use:enhance={submitHandler({
              setPending: (v) => (togglePending = v),
              setErrors: (e) => (toggleErrors = e),
              successMessage: connection.enabled
                ? "Sync paused."
                : "Sync resumed.",
            })}
          >
            <input
              type="hidden"
              name="enabled"
              value={String(!connection.enabled)}
            />
            <Switch
              id="enabled"
              checked={connection.enabled}
              disabled={togglePending}
              onCheckedChange={() => toggleForm?.requestSubmit()}
            />
            <Label for="enabled">Sync enabled</Label>
          </form>
          <Button
            type="button"
            variant="ghost"
            class="text-destructive hover:text-destructive ms-auto"
            onclick={() => (disconnectOpen = true)}
          >
            <UnplugIcon /> Disconnect
          </Button>
        </div>
        <FormAlert message={formError(testErrors) ?? formError(toggleErrors)} />
        {#if testError}
          <div class="grid gap-1">
            <FormAlert message={testError} />
            <p class="text-muted-foreground text-xs">
              The connection was saved. Fix the address or token and save again.
            </p>
          </div>
        {:else if testResult}
          <div class="grid gap-2 rounded-md border p-3 text-sm" role="status">
            <p class="flex items-center gap-2 font-medium">
              <CircleCheckIcon
                class="size-4 text-emerald-600 dark:text-emerald-400"
              />
              Connected to Paperless-ngx {testResult.serverVersion}
            </p>
            <p class="text-muted-foreground">
              API version {testResult.apiVersion} in use (server supports up to
              {testResult.maxApiVersion}).
            </p>
            {#each testResult.warnings as warning (warning)}
              <p
                class="flex items-start gap-2 text-amber-800 dark:text-amber-300"
              >
                <TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
                <span class="min-w-0 break-words">{warning}</span>
              </p>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <p class="text-muted-foreground text-xs">{data.notes.privateHosts}</p>
  </Card.Content>
</Card.Root>

{#if connection}
  <ConfirmActionDialog
    bind:open={disconnectOpen}
    title="Disconnect Paperless-ngx?"
    description="Kept forgets the address, token and webhook secret and stops syncing. Bills already imported stay in Kept, with their documents; they just stop being updated in Paperless. Nothing is deleted in Paperless."
    action="?/disconnect"
    confirmLabel="Disconnect"
    successMessage="Disconnected."
  />
{/if}
