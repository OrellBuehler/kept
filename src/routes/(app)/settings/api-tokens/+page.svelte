<script lang="ts">
  import { enhance } from "$app/forms";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import BanIcon from "@lucide/svelte/icons/ban";
  import { API_SCOPE_LABELS, type ApiScope } from "$lib/api-tokens";
  import { categoryLabel } from "$lib/category-types";
  import {
    fieldErrors,
    formError,
    hasError,
    type FormErrors,
  } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { usePreferences } from "$lib/preferences.svelte";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
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

  let createOpen = $state(false);
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let scopes = $state<string[]>([]);
  let restrict = $state(false);
  let categoryIds = $state<string[]>([]);
  let secret = $state<{ name: string; token: string } | null>(null);
  let revokeTarget = $state<Token | null>(null);
  let revokeOpen = $state(false);

  const names = $derived(
    new Map(
      data.categories.map((c) => [c.id, categoryLabel(c, data.categories)]),
    ),
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

  function toggle(list: string[], value: string, on: boolean): string[] {
    return on
      ? [...list.filter((v) => v !== value), value]
      : list.filter((v) => v !== value);
  }

  function tokenStatus(token: Token): "active" | "revoked" | "expired" {
    if (token.revokedAt !== null) return "revoked";
    if (token.expiresAt !== null && token.expiresAt <= Date.now())
      return "expired";
    return "active";
  }

  function openCreate() {
    errors = {};
    scopes = [];
    restrict = false;
    categoryIds = [];
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
        Let another app you run read your bills and payments, or attach links to
        them. A token only works on <code class="text-xs"
          >/api/external/v1/</code
        >, can do exactly what you tick below, and can be revoked at any time.
        It never grants access to your login or settings.
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
                    >{token.prefix}…</code
                  >
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
              <dl
                class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5"
              >
                <dt class="text-muted-foreground">Can</dt>
                <dd class="flex flex-wrap gap-1">
                  {#each token.scopes as scope (scope)}
                    <Badge variant="outline" class="font-mono text-xs"
                      >{scope}</Badge
                    >
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

        <Field.Set>
          <Field.Legend variant="label">Permissions</Field.Legend>
          {#each scopes as scope (scope)}
            <input type="hidden" name="scope" value={scope} />
          {/each}
          <div class="grid gap-2">
            {#each data.scopes as scope (scope)}
              <div class="flex items-start gap-3">
                <Checkbox
                  id="{uid}-scope-{scope}"
                  class="mt-0.5"
                  checked={scopes.includes(scope)}
                  onCheckedChange={(v) =>
                    (scopes = toggle(scopes, scope, v === true))}
                />
                <Label
                  for="{uid}-scope-{scope}"
                  class="grid gap-0.5 leading-snug"
                >
                  <span class="font-mono text-xs">{scope}</span>
                  <span class="text-muted-foreground font-normal">
                    {API_SCOPE_LABELS[scope as ApiScope]}
                  </span>
                </Label>
              </div>
            {/each}
          </div>
          <Field.Error errors={fieldErrors(errors, "scopes")} />
        </Field.Set>

        <Field.Set>
          <Field.Legend variant="label">Categories</Field.Legend>
          {#if restrict}<input type="hidden" name="restrict" value="on" />{/if}
          <div class="flex items-start gap-3">
            <Checkbox
              id="{uid}-restrict"
              class="mt-0.5"
              bind:checked={restrict}
              aria-describedby="{uid}-restrict-hint"
            />
            <div class="grid gap-1">
              <Label for="{uid}-restrict" class="leading-snug">
                Only show transactions in chosen categories
              </Label>
              <p id="{uid}-restrict-hint" class="text-muted-foreground text-xs">
                Applies to transactions and categories, and such a token cannot
                read recurring payments. Bills and accounts are not tied to a
                category: a bill's paid amount counts payments in any category.
              </p>
            </div>
          </div>
          {#if restrict}
            {#each categoryIds as id (id)}
              <input type="hidden" name="categoryId" value={id} />
            {/each}
            {#if data.categories.length === 0}
              <p class="text-muted-foreground text-sm">
                You have no categories yet.
              </p>
            {:else}
              <div
                class="grid max-h-48 gap-2 overflow-y-auto rounded-md border p-3"
              >
                {#each data.categories as category (category.id)}
                  <div class="flex items-center gap-3">
                    <Checkbox
                      id="{uid}-cat-{category.id}"
                      checked={categoryIds.includes(category.id)}
                      onCheckedChange={(v) =>
                        (categoryIds = toggle(
                          categoryIds,
                          category.id,
                          v === true,
                        ))}
                    />
                    <Label
                      for="{uid}-cat-{category.id}"
                      class="font-normal break-words"
                    >
                      {names.get(category.id)}
                    </Label>
                  </div>
                {/each}
              </div>
            {/if}
            <Field.Error errors={fieldErrors(errors, "categoryIds")} />
          {/if}
        </Field.Set>

        <Field.Field>
          <Field.Label for="{uid}-expires">
            Expires <span class="text-muted-foreground">(optional)</span>
          </Field.Label>
          <Input
            id="{uid}-expires"
            name="expires"
            type="date"
            value={failure?.values?.expires ?? ""}
            aria-invalid={hasError(errors, "expires")}
          />
          <Field.Description
            >Valid through the end of that day (UTC).</Field.Description
          >
          <Field.Error errors={fieldErrors(errors, "expires")} />
        </Field.Field>

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

<ConfirmActionDialog
  bind:open={revokeOpen}
  title={`Revoke "${revokeTarget?.name ?? ""}"?`}
  description="The token stops working immediately. Apps using it get an error until you give them a new one. This cannot be undone."
  action="?/revoke"
  fields={{ tokenId: revokeTarget?.id ?? "" }}
  confirmLabel="Revoke token"
  successMessage="Token revoked."
/>
