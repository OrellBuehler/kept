<script lang="ts">
  import {
    API_SCOPE_LABELS,
    type ApiScope,
    type RestrictionKind,
  } from "$lib/api-tokens";
  import { categoryLabel } from "$lib/category-types";
  import { fieldErrors, hasError, type FormErrors } from "$lib/form-errors";
  import * as Field from "$lib/components/ui/field/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  /**
   * What a credential may do: the permissions, an optional restriction to
   * accounts and categories, and an expiry. Shared by the API token form and
   * the consent page of a connected app, so both apply the same rules.
   */
  let {
    idPrefix,
    scopeGroups,
    scopeConflicts,
    categories,
    accounts,
    errors,
    expires = "",
    scopes = $bindable(),
    restrict = $bindable(),
    categoryIds = $bindable(),
    restrictAccounts = $bindable(),
    accountIds = $bindable(),
    granted = $bindable([]),
  }: {
    idPrefix: string;
    scopeGroups: readonly { title: string; scopes: readonly string[] }[];
    scopeConflicts: Partial<
      Record<
        string,
        { what: string } & Partial<Record<RestrictionKind, string>>
      >
    >;
    categories: { id: string; name: string; parentId: string | null }[];
    accounts: { id: string; name: string; archived?: boolean }[];
    errors: FormErrors;
    expires?: string;
    scopes: string[];
    restrict: boolean;
    categoryIds: string[];
    restrictAccounts: boolean;
    accountIds: string[];
    /** Output: the ticked permissions that survive the restrictions, i.e. what is submitted. */
    granted?: string[];
  } = $props();

  const names = $derived(
    new Map(categories.map((c) => [c.id, categoryLabel(c, categories)])),
  );

  function toggle(list: string[], value: string, on: boolean): string[] {
    return on
      ? [...list.filter((v) => v !== value), value]
      : list.filter((v) => v !== value);
  }

  $effect.pre(() => {
    granted = scopes.filter((s) => !conflictOf(s));
  });

  /** Why a permission cannot be combined with the chosen restrictions, or null. */
  function conflictOf(scope: string): string | null {
    const conflict = scopeConflicts[scope];
    if (!conflict) return null;
    if (restrict && conflict.categories) {
      return `Not with a category restriction: ${conflict.categories}.`;
    }
    if (restrictAccounts && conflict.accounts) {
      return `Not with an account restriction: ${conflict.accounts}.`;
    }
    return null;
  }
</script>

<Field.Set>
  <Field.Legend variant="label">Permissions</Field.Legend>
  {#each scopes.filter((s) => !conflictOf(s)) as scope (scope)}
    <input type="hidden" name="scope" value={scope} />
  {/each}
  <div class="grid gap-4">
    {#each scopeGroups as group (group.title)}
      <div class="grid gap-2">
        <p class="text-muted-foreground text-xs font-medium uppercase">
          {group.title}
        </p>
        {#each group.scopes as scope (scope)}
          {@const conflict = conflictOf(scope)}
          <div class="flex items-start gap-3">
            <Checkbox
              id="{idPrefix}-scope-{scope}"
              class="mt-0.5"
              disabled={conflict !== null}
              checked={scopes.includes(scope) && conflict === null}
              onCheckedChange={(v) =>
                (scopes = toggle(scopes, scope, v === true))}
            />
            <Label
              for="{idPrefix}-scope-{scope}"
              class="grid gap-0.5 leading-snug"
            >
              <span class="font-mono text-xs">{scope}</span>
              <span class="text-muted-foreground font-normal">
                {API_SCOPE_LABELS[scope as ApiScope]}
              </span>
              {#if conflict}
                <span class="text-xs font-normal">{conflict}</span>
              {/if}
            </Label>
          </div>
        {/each}
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
      id="{idPrefix}-restrict"
      class="mt-0.5"
      bind:checked={restrict}
      aria-describedby="{idPrefix}-restrict-hint"
    />
    <div class="grid gap-1">
      <Label for="{idPrefix}-restrict" class="leading-snug">
        Only show transactions in chosen categories
      </Label>
      <p id="{idPrefix}-restrict-hint" class="text-muted-foreground text-xs">
        Applies to transactions and categories. Totals across all categories
        (balances, budgets, recurring payments, the forecast, taxes) and editing
        categories are not available to such a token. Bills and accounts are not
        tied to a category: a bill's paid amount counts payments in any
        category.
      </p>
    </div>
  </div>
  {#if restrict}
    {#each categoryIds as id (id)}
      <input type="hidden" name="categoryId" value={id} />
    {/each}
    {#if categories.length === 0}
      <p class="text-muted-foreground text-sm">You have no categories yet.</p>
    {:else}
      <div class="grid max-h-48 gap-2 overflow-y-auto rounded-md border p-3">
        {#each categories as category (category.id)}
          <div class="flex items-center gap-3">
            <Checkbox
              id="{idPrefix}-cat-{category.id}"
              checked={categoryIds.includes(category.id)}
              onCheckedChange={(v) =>
                (categoryIds = toggle(categoryIds, category.id, v === true))}
            />
            <Label
              for="{idPrefix}-cat-{category.id}"
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

<Field.Set>
  <Field.Legend variant="label">Accounts</Field.Legend>
  {#if restrictAccounts}
    <input type="hidden" name="restrictAccounts" value="on" />
  {/if}
  <div class="flex items-start gap-3">
    <Checkbox
      id="{idPrefix}-restrict-accounts"
      class="mt-0.5"
      bind:checked={restrictAccounts}
      aria-describedby="{idPrefix}-restrict-accounts-hint"
    />
    <div class="grid gap-1">
      <Label for="{idPrefix}-restrict-accounts" class="leading-snug">
        Only show chosen accounts
      </Label>
      <p
        id="{idPrefix}-restrict-accounts-hint"
        class="text-muted-foreground text-xs"
      >
        Applies to payments, balances, accounts and holdings. Totals across all
        accounts (net worth, budgets, recurring payments, the forecast, pillar
        3a, taxes) and editing categories are not available to such a token. A
        bill's paid amount still counts payments in any account.
      </p>
    </div>
  </div>
  {#if restrictAccounts}
    {#each accountIds as id (id)}
      <input type="hidden" name="accountId" value={id} />
    {/each}
    {#if accounts.length === 0}
      <p class="text-muted-foreground text-sm">You have no accounts yet.</p>
    {:else}
      <div class="grid max-h-48 gap-2 overflow-y-auto rounded-md border p-3">
        {#each accounts as account (account.id)}
          <div class="flex items-center gap-3">
            <Checkbox
              id="{idPrefix}-acc-{account.id}"
              checked={accountIds.includes(account.id)}
              onCheckedChange={(v) =>
                (accountIds = toggle(accountIds, account.id, v === true))}
            />
            <Label
              for="{idPrefix}-acc-{account.id}"
              class="font-normal break-words"
            >
              {account.name}{account.archived ? " (archived)" : ""}
            </Label>
          </div>
        {/each}
      </div>
    {/if}
    <Field.Error errors={fieldErrors(errors, "accountIds")} />
  {/if}
</Field.Set>

{#if (restrict || restrictAccounts) && scopes.includes("bills:read") && !conflictOf("bills:read")}
  <p class="text-muted-foreground rounded-md border border-dashed p-3 text-xs">
    A restriction does not hide payments from bills. With <span
      class="font-mono"
    >
      bills:read
    </span>, a bill's paid and remaining amounts and its last payment date still
    count payments in any account or category.
  </p>
{/if}

<Field.Field>
  <Field.Label for="{idPrefix}-expires">
    Expires <span class="text-muted-foreground">(optional)</span>
  </Field.Label>
  <Input
    id="{idPrefix}-expires"
    name="expires"
    type="date"
    value={expires}
    aria-invalid={hasError(errors, "expires")}
  />
  <Field.Description>
    Valid through the end of that day (UTC).
  </Field.Description>
  <Field.Error errors={fieldErrors(errors, "expires")} />
</Field.Field>
