<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import BotIcon from "@lucide/svelte/icons/bot";
  import CogIcon from "@lucide/svelte/icons/cog";
  import KeyRoundIcon from "@lucide/svelte/icons/key-round";
  import SmartphoneIcon from "@lucide/svelte/icons/smartphone";
  import UndoIcon from "@lucide/svelte/icons/undo-2";
  import UserIcon from "@lucide/svelte/icons/user";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import {
    ACTOR_FILTER_LABELS,
    actionLabel,
    actorText,
    diffRows,
    ENTITY_LABELS,
    entityLabel,
    MONEY_FIELDS,
    revertEffect,
    type FormatContext,
  } from "$lib/changes";
  import { usePreferences } from "$lib/preferences.svelte";
  import { cn } from "$lib/utils";
  import * as Alert from "$lib/components/ui/alert/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Empty from "$lib/components/ui/empty/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Checkbox } from "$lib/components/ui/checkbox/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select";
  import NativeSelectOption from "$lib/components/ui/native-select/native-select-option.svelte";
  import ConfirmActionDialog from "$lib/components/ConfirmActionDialog.svelte";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import LocalTime from "$lib/components/app/local-time.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const prefs = usePreferences();
  const uid = $props.id();

  type Row = (typeof data.items)[number];

  const ctx: FormatContext = $derived({
    refs: data.refs,
    amount: (v, c) => prefs.amount(v, c),
    date: (iso) => prefs.date(iso),
    dateTime: (ms) => prefs.dateTime(ms),
    iban: (iban) => prefs.iban(iban),
  });

  /** The query string and fragment of a link to this page. */
  function query(
    params: Record<string, string | null | undefined>,
    hash?: string,
  ) {
    const qs = new SvelteURLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    const text = qs.toString();
    return (text ? `?${text}` : "") + (hash ? `#${hash}` : "");
  }

  /** A form action that keeps the filters and the page of the current URL. */
  function actionUrl(name: string) {
    const qs = new SvelteURLSearchParams(page.url.search);
    return `?${qs.toString()}${qs.size > 0 ? "&" : ""}/${name}`;
  }

  function href(
    params: Record<string, string | null | undefined>,
    hash?: string,
  ) {
    return resolve("/(app)/settings/changes") + query(params, hash);
  }

  const filterParams = $derived({
    actor: data.filters.actor,
    token: data.filters.token,
    type: data.filters.type,
    entity: data.filters.entity,
  });

  const filtered = $derived(Object.values(data.filters).some((v) => v));
  const tokenLabel = $derived(
    data.filters.token
      ? (data.actors.find((a) => a.tokenId === data.filters.token)?.label ??
          "this connection")
      : null,
  );
  const tokenKind = $derived(
    data.actors.find((a) => a.tokenId === data.filters.token)?.kind ?? null,
  );

  let selected = $state<string[]>([]);
  const revertibleIds = $derived(
    new Set(data.items.filter((e) => e.blocked === null).map((e) => e.id)),
  );
  const chosen = $derived(selected.filter((id) => revertibleIds.has(id)));

  let revertTarget = $state<Row | null>(null);
  let revertOpen = $state(false);
  let selectedOpen = $state(false);
  let allOpen = $state(false);

  function toggle(id: string, on: boolean) {
    selected = on ? [...selected, id] : selected.filter((v) => v !== id);
  }

  const result = $derived(
    form && "reverted" in form
      ? (form as {
          reverted: number;
          warnings: string[];
          capped: boolean;
          stoppedAt: { entryId: string; message: string } | null;
        })
      : null,
  );
  const failure = $derived(
    form && "errors" in form
      ? (form as { errors: Record<string, string[]> }).errors
      : undefined,
  );

  const actorIcons = {
    web: UserIcon,
    mcp: BotIcon,
    api: KeyRoundIcon,
    app: SmartphoneIcon,
    system: CogIcon,
  } as const;

  function entityRef(entry: Row) {
    if (entry.entityType === "bill" && data.refs.bills[entry.entityId]) {
      return resolve("/(app)/bills/[id]", { id: entry.entityId });
    }
    return null;
  }

  function plural(n: number, one: string, many: string) {
    return `${n} ${n === 1 ? one : many}`;
  }
</script>

<svelte:head>
  <title>Change log · Settings · Kept</title>
</svelte:head>

<div class="grid gap-6">
  <Card.Root>
    <Card.Header>
      <Card.Title>Change log</Card.Title>
      <Card.Description>
        Every change to your data, newest first: what you did in the web app,
        what an assistant did through MCP, and what an API token, the mobile app
        or Kept itself did. Most changes can be reverted here.
      </Card.Description>
    </Card.Header>
    <Card.Content class="grid gap-4">
      <form
        method="GET"
        action={href({})}
        class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
        aria-label="Filter the change log"
      >
        <div class="grid gap-1.5">
          <Label for="{uid}-actor">Who</Label>
          <NativeSelect
            id="{uid}-actor"
            name="actor"
            class="w-full"
            value={data.filters.actor ?? ""}
          >
            <NativeSelectOption value="">Everyone</NativeSelectOption>
            {#each Object.entries(ACTOR_FILTER_LABELS) as [kind, label] (kind)}
              <NativeSelectOption value={kind}>{label}</NativeSelectOption>
            {/each}
          </NativeSelect>
        </div>
        <div class="grid gap-1.5">
          <Label for="{uid}-token">Token or connection</Label>
          <NativeSelect
            id="{uid}-token"
            name="token"
            class="w-full"
            value={data.filters.token ?? ""}
          >
            <NativeSelectOption value="">Any</NativeSelectOption>
            {#each data.actors as actor (actor.tokenId)}
              <NativeSelectOption value={actor.tokenId}>
                {actorText({ kind: actor.kind, label: actor.label })}
              </NativeSelectOption>
            {/each}
            {#if data.filters.token && !data.actors.some((a) => a.tokenId === data.filters.token)}
              <NativeSelectOption value={data.filters.token}>
                Unknown connection
              </NativeSelectOption>
            {/if}
          </NativeSelect>
        </div>
        <div class="grid gap-1.5">
          <Label for="{uid}-type">What</Label>
          <NativeSelect
            id="{uid}-type"
            name="type"
            class="w-full"
            value={data.filters.type ?? ""}
          >
            <NativeSelectOption value="">Everything</NativeSelectOption>
            {#each data.entityTypes as type (type)}
              <NativeSelectOption value={type}>
                {ENTITY_LABELS[type]?.many ?? type}
              </NativeSelectOption>
            {/each}
          </NativeSelect>
        </div>
        <div class="flex items-end gap-2">
          <Button type="submit">Apply</Button>
          {#if filtered}
            <Button variant="outline" href={href({})}>Clear</Button>
          {/if}
        </div>
        {#if data.filters.entity}
          <input type="hidden" name="entity" value={data.filters.entity} />
        {/if}
      </form>

      {#if data.filters.entity}
        <p class="flex flex-wrap items-center gap-2 text-sm">
          <HistoryIcon class="text-muted-foreground size-4" />
          Showing the history of one
          {data.filters.type
            ? entityLabel(data.filters.type).toLowerCase()
            : "record"}.
          <a
            class="text-primary underline underline-offset-4"
            href="{resolve('/(app)/settings/changes')}{query({
              ...filterParams,
              entity: null,
            })}"
          >
            Show all
          </a>
        </p>
      {/if}
    </Card.Content>
  </Card.Root>

  {#if result}
    <Alert.Root role="status">
      <Alert.Title>
        {result.reverted === 0
          ? "Nothing was reverted"
          : `Reverted ${plural(result.reverted, "change", "changes")}`}
      </Alert.Title>
      <Alert.Description class="grid gap-1">
        {#if result.stoppedAt}
          <p>
            Stopped at
            <a
              class="text-primary underline underline-offset-4"
              href="#entry-{result.stoppedAt.entryId}"
            >
              one change
            </a>
            and did not try the rest: {result.stoppedAt.message}
          </p>
        {/if}
        {#if result.capped}
          <p>
            Only the newest {data.revertAllLimit} changes were tried. Run it again
            for the rest.
          </p>
        {/if}
        {#each result.warnings as warning, i (i)}
          <p>{warning}</p>
        {/each}
      </Alert.Description>
    </Alert.Root>
  {/if}
  <FormAlert message={failure?.form?.[0]} />

  {#if data.filters.token}
    <Card.Root class="border-primary/40">
      <Card.Header>
        <Card.Title class="flex flex-wrap items-center gap-2 text-base">
          {#if tokenKind === "mcp"}<BotIcon
              class="size-4"
            />{:else}<KeyRoundIcon class="size-4" />{/if}
          {tokenLabel}
        </Card.Title>
        <Card.Description>
          You are looking at what this {tokenKind === "mcp"
            ? "assistant connection"
            : "token"} changed. You can undo all of it at once; Kept stops at the
          first change it cannot undo and tells you why.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <Button
          type="button"
          variant="outline"
          class="text-destructive"
          onclick={() => (allOpen = true)}
        >
          <UndoIcon /> Revert all changes of this connection
        </Button>
      </Card.Content>
    </Card.Root>
  {/if}

  {#if chosen.length > 0}
    <div
      class="bg-card sticky top-2 z-10 flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 shadow-sm"
      role="region"
      aria-label="Selected changes"
    >
      <p class="text-sm">
        {plural(chosen.length, "change", "changes")} selected
      </p>
      <div class="flex gap-2">
        <Button type="button" variant="ghost" onclick={() => (selected = [])}>
          Clear
        </Button>
        <Button
          type="button"
          variant="outline"
          class="text-destructive"
          onclick={() => (selectedOpen = true)}
        >
          <UndoIcon /> Revert selected
        </Button>
      </div>
    </div>
  {/if}

  {#if data.items.length === 0}
    <Empty.Root class="rounded-lg border border-dashed">
      <Empty.Header>
        <Empty.Media variant="icon"><HistoryIcon /></Empty.Media>
        <Empty.Title>
          {filtered ? "No changes match" : "No changes recorded yet"}
        </Empty.Title>
        <Empty.Description>
          {filtered
            ? "Try a different filter."
            : "Changes you, an assistant, an API token or the app make will show up here."}
        </Empty.Description>
      </Empty.Header>
      {#if filtered}
        <Empty.Content>
          <Button variant="outline" href={href({})}>Clear filters</Button>
        </Empty.Content>
      {/if}
    </Empty.Root>
  {:else}
    <ol class="grid gap-3" aria-label="Changes, newest first">
      {#each data.items as entry (entry.id)}
        {@const Icon = actorIcons[entry.actor.kind]}
        {@const rows = diffRows(entry, ctx)}
        {@const link = entityRef(entry)}
        <li
          id="entry-{entry.id}"
          class={cn(
            "bg-card target:ring-ring/60 scroll-mt-4 rounded-lg border p-4 text-sm target:ring-2",
            entry.actor.kind === "mcp" && "border-l-primary border-l-4",
            entry.revertedAt !== null && "opacity-80",
          )}
        >
          <div class="flex items-start gap-3">
            {#if entry.blocked === null}
              <Checkbox
                class="mt-0.5"
                aria-label="Select this change for reverting"
                checked={chosen.includes(entry.id)}
                onCheckedChange={(on) => toggle(entry.id, on === true)}
              />
            {/if}
            <div class="grid min-w-0 flex-1 gap-2">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge
                  variant={entry.actor.kind === "mcp"
                    ? "default"
                    : entry.actor.kind === "web"
                      ? "secondary"
                      : "outline"}
                >
                  <Icon aria-hidden="true" />
                  {actorText(entry.actor)}
                </Badge>
                <span class="text-muted-foreground text-xs">
                  <LocalTime ms={entry.at} />
                </span>
                {#if entry.revertedAt !== null}
                  <Badge variant="outline">
                    Reverted <LocalTime ms={entry.revertedAt} />
                  </Badge>
                {/if}
                {#if entry.revertOfEntryId}
                  <Badge variant="outline">Revert</Badge>
                {/if}
              </div>
              <p class="font-medium break-words">
                {actionLabel(entry.action)}
                {#if entry.summary}
                  <span class="text-muted-foreground font-normal">
                    ·
                    {#if link}
                      <a
                        class="text-foreground underline underline-offset-4"
                        href={link}
                      >
                        {entry.summary}
                      </a>
                    {:else}
                      {entry.summary}
                    {/if}
                  </span>
                {/if}
              </p>
              <p class="text-muted-foreground text-xs">
                {entityLabel(entry.entityType)}
                ·
                <a
                  class="underline underline-offset-4"
                  href="{resolve('/(app)/settings/changes')}{query({
                    type: entry.entityType,
                    entity: entry.entityId,
                  })}"
                >
                  History
                </a>
                {#if entry.revertOfEntryId}
                  ·
                  <a
                    class="underline underline-offset-4"
                    href="{resolve('/(app)/settings/changes')}{query(
                      { type: entry.entityType, entity: entry.entityId },
                      `entry-${entry.revertOfEntryId}`,
                    )}"
                  >
                    Undoes an earlier change
                  </a>
                {/if}
                {#if entry.revertedByEntryId}
                  ·
                  <a
                    class="underline underline-offset-4"
                    href="{resolve('/(app)/settings/changes')}{query(
                      { type: entry.entityType, entity: entry.entityId },
                      `entry-${entry.revertedByEntryId}`,
                    )}"
                  >
                    See the revert
                  </a>
                {/if}
              </p>

              {#if rows.length > 0}
                <details class="group">
                  <summary
                    class="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 w-fit cursor-pointer rounded text-xs underline underline-offset-4 outline-none focus-visible:ring-[3px]"
                  >
                    {plural(rows.length, "field", "fields")}
                  </summary>
                  <dl class="mt-2 grid gap-2">
                    {#each rows as row (row.field)}
                      <div
                        class={cn(
                          "grid gap-x-3 gap-y-0.5 border-t pt-2",
                          row.before !== null && row.after !== null
                            ? "sm:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]"
                            : "sm:grid-cols-[10rem_minmax(0,1fr)]",
                        )}
                      >
                        <dt class="text-muted-foreground">{row.label}</dt>
                        {#if row.before !== null}
                          <dd
                            class={cn(
                              "min-w-0 break-words tabular-nums",
                              row.after !== null &&
                                "text-muted-foreground line-through",
                              MONEY_FIELDS.has(row.field) &&
                                row.before !== null &&
                                row.after !== null &&
                                "sm:text-right",
                            )}
                          >
                            {#if row.after !== null}<span class="sr-only">
                                Before:
                              </span>{/if}{row.before}
                          </dd>
                        {/if}
                        {#if row.after !== null}
                          <dd
                            class={cn(
                              "min-w-0 break-words tabular-nums",
                              MONEY_FIELDS.has(row.field) &&
                                row.before !== null &&
                                row.after !== null &&
                                "sm:text-right",
                            )}
                          >
                            {#if row.before !== null}<span class="sr-only">
                                After:
                              </span>{/if}{row.after}
                          </dd>
                        {/if}
                      </div>
                    {/each}
                  </dl>
                </details>
              {/if}

              {#if entry.blocked === null}
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    class="text-destructive"
                    onclick={() => {
                      revertTarget = entry;
                      revertOpen = true;
                    }}
                  >
                    <UndoIcon /> Revert
                  </Button>
                </div>
              {:else if entry.revertedAt === null}
                <p class="text-muted-foreground text-xs">{entry.blocked}</p>
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ol>

    <nav
      class="flex flex-wrap items-center justify-between gap-2"
      aria-label="Pages"
    >
      {#if !data.isFirstPage}
        <Button variant="outline" href={href(filterParams)}>
          Back to the newest
        </Button>
      {:else}
        <span></span>
      {/if}
      {#if data.nextCursor}
        <Button
          variant="outline"
          href={href({ ...filterParams, before: data.nextCursor })}
        >
          Older changes
        </Button>
      {:else}
        <p class="text-muted-foreground text-sm">That is everything.</p>
      {/if}
    </nav>
  {/if}
</div>

<ConfirmActionDialog
  bind:open={revertOpen}
  title="Revert this change?"
  description={revertTarget
    ? `${actionLabel(revertTarget.action)}${revertTarget.summary ? `: ${revertTarget.summary}` : ""}. ${revertEffect(revertTarget.action, entityLabel(revertTarget.entityType))} Kept refuses if the data was changed since in a way this would lose.`
    : ""}
  action={actionUrl("revert")}
  fields={{ entryId: revertTarget?.id ?? "" }}
  confirmLabel="Revert"
  successMessage="Change reverted"
/>

<ConfirmActionDialog
  bind:open={selectedOpen}
  title="Revert {plural(chosen.length, 'change', 'changes')}?"
  description="Each change is undone on its own, newest first: what was created is deleted, what was deleted is restored, edited fields go back to their earlier values. Kept stops at the first one it cannot undo and tells you why."
  action={actionUrl("revertSelected")}
  confirmLabel="Revert selected"
  successMessage="Changes reverted"
>
  {#each chosen as id (id)}
    <input type="hidden" name="entryId" value={id} />
  {/each}
</ConfirmActionDialog>

<ConfirmActionDialog
  bind:open={allOpen}
  title="Revert all changes of this connection?"
  description="Every change {tokenLabel ??
    'it'} made that can still be undone is reverted, newest first, up to {data.revertAllLimit} at a time. Created records are deleted, deleted ones restored, edited fields set back. Kept stops at the first change it cannot undo and tells you why."
  action={actionUrl("revertAll")}
  fields={{ tokenId: data.filters.token ?? "" }}
  confirmLabel="Revert all"
  successMessage="Changes reverted"
/>
