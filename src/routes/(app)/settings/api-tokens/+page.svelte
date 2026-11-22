<script lang="ts">
  import { enhance } from "$app/forms";
  import { resolve } from "$app/paths";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import BanIcon from "@lucide/svelte/icons/ban";
  import PencilIcon from "@lucide/svelte/icons/pencil";
  import { categoryLabel } from "$lib/category-types";
  import {
    fieldErrors,
    formError,
    hasError,
    type FormErrors,
  } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { usePreferences } from "$lib/preferences.svelte";
  import AccessFields from "$lib/components/app/access-fields.svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import AdminConfirmFields from "$lib/components/app/admin-confirm-fields.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import LocalTime from "$lib/components/app/local-time.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import TokenSecret from "./token-secret.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const prefs = usePreferences();
  const uid = $props.id();

  type Token = (typeof data.tokens)[number];
  type Connection = (typeof data.connections)[number];

  let createOpen = $state(false);
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let scopes = $state<string[]>([]);
  let restrict = $state(false);
  let categoryIds = $state<string[]>([]);
  let restrictAccounts = $state(false);
  let accountIds = $state<string[]>([]);
  let secret = $state<{ name: string; token: string } | null>(null);
  let revokeTarget = $state<Token | null>(null);
  let revokeOpen = $state(false);
  let revokeConnection = $state<Connection | null>(null);
  let revokeConnectionOpen = $state(false);
  let renameTarget = $state<Connection | null>(null);
  let renameOpen = $state(false);
  let renamePending = $state(false);
  let renameErrors = $state<NonNullable<FormErrors>>({});

  const names = $derived(
    new Map(
      data.categories.map((c) => [c.id, categoryLabel(c, data.categories)]),
    ),
  );
  const accountNames = $derived(
    new Map(data.accounts.map((a) => [a.id, a.name])),
  );
  const failure = $derived(form && "values" in form ? form : null);
  // Without JavaScript the one-time token arrives as the form result.
  const shown = $derived(
    secret ??
      (form && "created" in form
        ? (form as { name: string; token: string })
        : null),
  );
  let dismissed = $state(false);

  function tokenStatus(token: Token): "active" | "revoked" | "expired" {
    if (token.revokedAt !== null) return "revoked";
    if (token.expiresAt !== null && token.expiresAt <= Date.now())
      return "expired";
    return "active";
  }

  function connectionStatus(
    connection: Connection,
  ): "active" | "revoked" | "expired" {
    if (connection.revokedAt !== null) return "revoked";
    if (connection.expiresAt !== null && connection.expiresAt <= Date.now())
      return "expired";
    return "active";
  }

  function openCreate() {
    errors = {};
    scopes = [];
    restrict = false;
    categoryIds = [];
    restrictAccounts = false;
    accountIds = [];
    createOpen = true;
  }
</script>

<svelte:head>
  <title>API tokens · Kept</title>
</svelte:head>

<div class="grid grid-cols-[minmax(0,1fr)] gap-6">
  {#if shown && !dismissed}
    <TokenSecret
      name={shown.name}
      secret={shown.token}
      ondismiss={() => {
        dismissed = true;
        secret = null;
      }}
    />
  {/if}

  <Card.Root>
    <Card.Header>
      <Card.Title>API tokens</Card.Title>
      <Card.Description>
        Let another app you run, or an AI assistant connected through MCP, read
        your bills and payments, or change what you allow. A token works on <code
          class="text-xs"
        >
          /api/external/v1/
        </code>
        and <code class="text-xs">/api/mcp</code>, can do exactly what you tick
        below, and can be revoked at any time. It never grants access to your
        login or settings.
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-4">
      <div>
        <Button type="button" onclick={openCreate}>
          <PlusIcon /> Create token
        </Button>
      </div>

      {#if data.tokens.length === 0}
        <p
          class="text-muted-foreground rounded-md border border-dashed p-4 text-sm"
        >
          No tokens yet.
        </p>
      {:else}
        <ul class="grid gap-3">
          {#each data.tokens as token (token.id)}
            {@const status = tokenStatus(token)}
            <li class="grid gap-3 rounded-lg border p-4 text-sm">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="grid min-w-0 gap-1">
                  <p class="flex flex-wrap items-center gap-2 font-medium">
                    <span class="break-words">{token.name}</span>
                    {#if status === "active"}
                      <Badge variant="secondary">Active</Badge>
                    {:else if status === "revoked"}
                      <Badge variant="outline">Revoked</Badge>
                    {:else}
                      <Badge variant="outline">Expired</Badge>
                    {/if}
                  </p>
                  <code
                    class="text-muted-foreground font-mono text-xs break-all"
                  >
                    {token.prefix}…
                  </code>
                </div>
                {#if status === "active"}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    class="text-destructive"
                    onclick={() => {
                      revokeTarget = token;
                      revokeOpen = true;
                    }}
                  >
                    <BanIcon /> Revoke
                  </Button>
                {/if}
              </div>
              <a
                href="{resolve('/(app)/settings/changes')}?token={token.id}"
                class="text-primary w-fit underline underline-offset-4"
              >
                See what this token changed
              </a>
              <dl
                class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5"
              >
                <dt class="text-muted-foreground">Can</dt>
                <dd class="flex flex-wrap gap-1">
                  {#each token.scopes as scope (scope)}
                    <Badge variant="outline" class="font-mono text-xs">
                      {scope}
                    </Badge>
                  {/each}
                </dd>
                <dt class="text-muted-foreground">Categories</dt>
                <dd class="min-w-0 break-words">
                  {#if token.categoryIds === null}
                    All
                  {:else}
                    {token.categoryIds
                      .map((id) => names.get(id) ?? "Deleted category")
                      .join(", ")}
                  {/if}
                </dd>
                <dt class="text-muted-foreground">Accounts</dt>
                <dd class="min-w-0 break-words">
                  {#if token.accountIds === null}
                    All
                  {:else}
                    {token.accountIds
                      .map((id) => accountNames.get(id) ?? "Deleted account")
                      .join(", ")}
                  {/if}
                </dd>
                <dt class="text-muted-foreground">Last used</dt>
                <dd>
                  {#if token.lastUsedAt !== null}
                    <LocalTime ms={token.lastUsedAt} />
                  {:else}
                    Never
                  {/if}
                </dd>
                <dt class="text-muted-foreground">Expires</dt>
                <dd>
                  {#if token.expiresAt !== null}
                    {prefs.date(
                      new Date(token.expiresAt).toISOString().slice(0, 10),
                    )}
                  {:else}
                    Never
                  {/if}
                </dd>
                <dt class="text-muted-foreground">Created</dt>
                <dd><LocalTime ms={token.createdAt} /></dd>
              </dl>
            </li>
          {/each}
        </ul>
      {/if}
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Connected apps</Card.Title>
      <Card.Description>
        Apps you signed in with, such as an AI assistant that connected to <code
          class="text-xs"
        >
          /api/mcp
        </code>
        through its sign-in page. Each can do exactly what you allowed there. Revoking
        one ends its access immediately. What an app with write permissions changed
        is recorded in the change log, where you can revert it.
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-4">
      {#if data.connections.length === 0}
        <p
          class="text-muted-foreground rounded-md border border-dashed p-4 text-sm"
        >
          No connected apps. Add Kept as an MCP server in your assistant and
          sign in when it asks.
        </p>
      {:else}
        <ul class="grid gap-3">
          {#each data.connections as connection (connection.id)}
            {@const status = connectionStatus(connection)}
            <li class="grid gap-3 rounded-lg border p-4 text-sm">
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div class="grid min-w-0 gap-1">
                  <p class="flex flex-wrap items-center gap-2 font-medium">
                    <span class="break-words">{connection.name}</span>
                    {#if status === "active"}
                      <Badge variant="secondary">Active</Badge>
                    {:else if status === "revoked"}
                      <Badge variant="outline">Revoked</Badge>
                    {:else}
                      <Badge variant="outline">Expired</Badge>
                    {/if}
                  </p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onclick={() => {
                      renameErrors = {};
                      renameTarget = connection;
                      renameOpen = true;
                    }}
                  >
                    <PencilIcon /> Rename
                  </Button>
                  {#if status === "active"}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      class="text-destructive"
                      onclick={() => {
                        revokeConnection = connection;
                        revokeConnectionOpen = true;
                      }}
                    >
                      <BanIcon /> Revoke
                    </Button>
                  {/if}
                </div>
              </div>
              <a
                href="{resolve(
                  '/(app)/settings/changes',
                )}?token={connection.id}"
                class="text-primary w-fit underline underline-offset-4"
              >
                See what this app changed
              </a>
              <dl
                class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5"
              >
                <dt class="text-muted-foreground">Can</dt>
                <dd class="flex flex-wrap gap-1">
                  {#each connection.scopes as scope (scope)}
                    <Badge variant="outline" class="font-mono text-xs">
                      {scope}
                    </Badge>
                  {/each}
                </dd>
                <dt class="text-muted-foreground">Categories</dt>
                <dd class="min-w-0 break-words">
                  {#if connection.categoryIds === null}
                    All
                  {:else}
                    {connection.categoryIds
                      .map((id) => names.get(id) ?? "Deleted category")
                      .join(", ")}
                  {/if}
                </dd>
                <dt class="text-muted-foreground">Accounts</dt>
                <dd class="min-w-0 break-words">
                  {#if connection.accountIds === null}
                    All
                  {:else}
                    {connection.accountIds
                      .map((id) => accountNames.get(id) ?? "Deleted account")
                      .join(", ")}
                  {/if}
                </dd>
                <dt class="text-muted-foreground">Last used</dt>
                <dd>
                  {#if connection.lastUsedAt !== null}
                    <LocalTime ms={connection.lastUsedAt} />
                  {:else}
                    Never
                  {/if}
                </dd>
                <dt class="text-muted-foreground">Expires</dt>
                <dd>
                  {#if connection.expiresAt !== null}
                    {prefs.date(
                      new Date(connection.expiresAt).toISOString().slice(0, 10),
                    )}
                  {:else}
                    Never
                  {/if}
                </dd>
                <dt class="text-muted-foreground">Connected</dt>
                <dd><LocalTime ms={connection.createdAt} /></dd>
              </dl>
            </li>
          {/each}
        </ul>
      {/if}
    </Card.Content>
  </Card.Root>
</div>

<Dialog.Root bind:open={createOpen}>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Create API token</Dialog.Title>
      <Dialog.Description>
        Give it a name, tick what it may do, and confirm it is you. Kept shows
        the token once.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action="?/create"
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: [
          "name",
          "scopes",
          "categoryIds",
          "accountIds",
          "expires",
          "adminPassword",
          "adminCode",
        ],
        onSuccessData: (d) => {
          if (d && typeof d.token === "string") {
            secret = { name: String(d.name ?? ""), token: d.token };
            dismissed = false;
            createOpen = false;
          }
        },
      })}
    >
      <FormAlert message={formError(errors) ?? formError(failure?.errors)} />
      <Field.Group>
        <Field.Field>
          <Field.Label for="{uid}-name">Name</Field.Label>
          <Input
            id="{uid}-name"
            name="name"
            required
            maxlength={64}
            autocomplete="off"
            placeholder="Home app"
            value={failure?.values?.name ?? ""}
            aria-invalid={hasError(errors, "name")}
          />
          <Field.Error errors={fieldErrors(errors, "name")} />
        </Field.Field>

        <AccessFields
          idPrefix={uid}
          scopeGroups={data.scopeGroups}
          scopeConflicts={data.scopeConflicts}
          categories={data.categories}
          accounts={data.accounts}
          {errors}
          expires={failure?.values?.expires ?? ""}
          bind:scopes
          bind:restrict
          bind:categoryIds
          bind:restrictAccounts
          bind:accountIds
        />

        <AdminConfirmFields
          idPrefix={uid}
          mode={data.confirmMode}
          {errors}
          description="Confirm it is you before creating a token."
        />
      </Field.Group>
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => (createOpen = false)}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {#if pending}<Spinner />Creating…{:else}Create token{/if}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={renameOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Rename app</Dialog.Title>
      <Dialog.Description>
        The name is shown here and in the change log from now on. Entries
        already written keep the name they were made under.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action="?/renameConnection"
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (renamePending = v),
        setErrors: (e) => (renameErrors = e),
        knownFields: ["name"],
        successMessage: "App renamed.",
        onSuccess: () => (renameOpen = false),
      })}
    >
      <FormAlert message={formError(renameErrors)} />
      <input type="hidden" name="connectionId" value={renameTarget?.id ?? ""} />
      <Field.Field>
        <Field.Label for="{uid}-rename">Name</Field.Label>
        <Input
          id="{uid}-rename"
          name="name"
          required
          maxlength={200}
          autocomplete="off"
          value={renameTarget?.name ?? ""}
          aria-invalid={hasError(renameErrors, "name")}
        />
        <Field.Error errors={fieldErrors(renameErrors, "name")} />
      </Field.Field>
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => (renameOpen = false)}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={renamePending}>
          {#if renamePending}<Spinner />Saving…{:else}Save{/if}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<ConfirmActionDialog
  bind:open={revokeOpen}
  title={`Revoke "${revokeTarget?.name ?? ""}"?`}
  description="The token stops working immediately. Apps using it get an error until you give them a new one. This cannot be undone."
  action="?/revoke"
  fields={{ tokenId: revokeTarget?.id ?? "" }}
  confirmLabel="Revoke token"
  successMessage="Token revoked."
/>

<ConfirmActionDialog
  bind:open={revokeConnectionOpen}
  title={`Revoke "${revokeConnection?.name ?? ""}"?`}
  description="The app is signed out immediately and can no longer reach your data. It has to ask for your permission again to connect. This cannot be undone."
  action="?/revokeConnection"
  fields={{ connectionId: revokeConnection?.id ?? "" }}
  confirmLabel="Revoke app"
  successMessage="App revoked."
/>
