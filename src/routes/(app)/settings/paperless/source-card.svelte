<script lang="ts">
  import { enhance } from "$app/forms";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import * as RadioGroup from "$lib/components/ui/radio-group/index.js";
  import * as NativeSelect from "$lib/components/ui/native-select/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { formError, type FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import type { PageData } from "./$types";

  type Connection = NonNullable<PageData["connection"]>;

  let {
    connection,
    lookups,
  }: {
    connection: Connection;
    lookups: NonNullable<PageData["lookups"]>;
  } = $props();

  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  // svelte-ignore state_referenced_locally
  let kind = $state<string>(connection.billSource?.kind ?? "tag");
  // svelte-ignore state_referenced_locally
  let selected = $state(String(connection.billSource?.id ?? ""));

  const KIND_LABEL = { tag: "Tag", saved_view: "Saved view" } as const;
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Bill source</Card.Title>
    <Card.Description>
      Documents with this tag, or matching this saved view, are imported as
      bills.
    </Card.Description>
  </Card.Header>
  <Card.Content class="grid grid-cols-[minmax(0,1fr)] gap-4">
    <p class="text-sm">
      {#if connection.billSource}
        Currently:
        <Badge variant="secondary" class="ms-1 max-w-full">
          <span class="truncate"
            >{KIND_LABEL[connection.billSource.kind]}: {connection.billSource
              .label}</span
          >
        </Badge>
      {:else}
        <span class="text-muted-foreground"
          >No source chosen yet. Nothing is imported until you pick one.</span
        >
      {/if}
    </p>

    <form
      method="POST"
      action="?/setSource"
      class="grid grid-cols-[minmax(0,1fr)] gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: ["kind", "id"],
        successMessage: "Bill source saved.",
      })}
    >
      <FormAlert message={formError(errors)} />
      <RadioGroup.Root
        name="kind"
        bind:value={kind}
        class="flex flex-wrap gap-x-6 gap-y-2"
        aria-label="Source type"
        onValueChange={() => (selected = "")}
      >
        {#each Object.entries(KIND_LABEL) as [value, label] (value)}
          <div class="flex items-center gap-2">
            <RadioGroup.Item {value} id="kind-{value}" />
            <Label for="kind-{value}">{label}</Label>
          </div>
        {/each}
      </RadioGroup.Root>

      {#await lookups}
        <Skeleton class="h-9 w-full" />
        <p class="text-muted-foreground text-xs">Loading from Paperless…</p>
      {:then lists}
        {@const items = kind === "tag" ? lists.tags : lists.savedViews}
        {@const listError =
          kind === "tag" ? lists.errors.tags : lists.errors.savedViews}
        <FormField
          class="[&_[data-slot=native-select-wrapper]]:w-full"
          label={kind === "tag" ? "Tag" : "Saved view"}
          for="source-id"
          errors={errors.id}
          hint={listError
            ? `Could not load the list from Paperless (${listError}). Enter the numeric id instead.`
            : undefined}
        >
          {#if items}
            <NativeSelect.Root
              id="source-id"
              name="id"
              bind:value={selected}
              class="w-full"
              aria-invalid={!!errors.id}
              required
            >
              <NativeSelect.Option value="" disabled>
                Choose a {kind === "tag" ? "tag" : "saved view"}…
              </NativeSelect.Option>
              {#if kind === "tag" && lists.tags}
                {#each lists.tags as tag (tag.id)}
                  <NativeSelect.Option value={String(tag.id)}>
                    {tag.name}{tag.documentCount !== null
                      ? ` (${tag.documentCount})`
                      : ""}
                  </NativeSelect.Option>
                {/each}
              {:else if lists.savedViews}
                {#each lists.savedViews as view (view.id)}
                  <NativeSelect.Option
                    value={String(view.id)}
                    disabled={!view.supported}
                  >
                    {view.name}{view.supported ? "" : " (unsupported)"}
                  </NativeSelect.Option>
                {/each}
              {/if}
            </NativeSelect.Root>
            {#if items.length === 0}
              <p class="text-muted-foreground text-xs">
                Paperless has no {kind === "tag" ? "tags" : "saved views"} yet.
              </p>
            {/if}
          {:else}
            <Input
              id="source-id"
              name="id"
              type="number"
              inputmode="numeric"
              min="1"
              required
              bind:value={selected}
              aria-invalid={!!errors.id}
            />
          {/if}
        </FormField>
        {#if kind === "saved_view" && lists.savedViews}
          {@const unsupported = lists.savedViews.filter((v) => !v.supported)}
          {#if unsupported.length > 0}
            <ul class="text-muted-foreground grid gap-1 text-xs">
              {#each unsupported as view (view.id)}
                <li class="break-words">
                  <span class="text-foreground font-medium">{view.name}</span>
                  cannot be used: {view.problem}
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      {:catch}
        <p class="text-destructive text-sm" role="alert">
          Could not load the list from Paperless. Reload the page to try again.
        </p>
      {/await}

      <Button type="submit" disabled={pending || !selected} class="self-start">
        {#if pending}<Spinner />Saving…{:else}Save source{/if}
      </Button>
    </form>
  </Card.Content>
</Card.Root>
