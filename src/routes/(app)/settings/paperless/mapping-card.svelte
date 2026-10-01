<script lang="ts">
  import { enhance } from "$app/forms";
  import * as Card from "$lib/components/ui/card/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as NativeSelect from "$lib/components/ui/native-select/index.js";
  import { Skeleton } from "$lib/components/ui/skeleton/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import FormField from "$lib/components/FormField.svelte";
  import { STATUS_LABELS } from "$lib/bill-display";
  import { formError, type FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import type { PageData } from "./$types";

  type Connection = NonNullable<PageData["connection"]>;
  type Lookups = Awaited<NonNullable<PageData["lookups"]>>;
  type CustomField = NonNullable<Lookups["customFields"]>[number];

  let {
    connection,
    lookups,
    billStatuses,
  }: {
    connection: Connection;
    lookups: NonNullable<PageData["lookups"]>;
    billStatuses: PageData["billStatuses"];
  } = $props();

  const mapping = $derived(connection.fieldMapping ?? {});

  const targets = [
    {
      key: "amount",
      label: "Amount",
      types: ["monetary"],
      hint: "A monetary field. Written as e.g. CHF123.45; currencies with other than two decimals are skipped.",
    },
    {
      key: "dueDate",
      label: "Due date",
      types: ["date"],
      hint: "A date field.",
    },
    {
      key: "reference",
      label: "Payment reference",
      types: ["string"],
      hint: "A text field.",
    },
    {
      key: "status",
      label: "Status",
      types: ["select", "string"],
      hint: "A selection or text field showing open, paid and so on.",
    },
  ] as const;

  const TYPE_LABELS: Record<string, string> = {
    monetary: "monetary",
    date: "date",
    string: "text",
    select: "selection",
  };

  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  // svelte-ignore state_referenced_locally
  let statusField = $state(String(connection.fieldMapping?.status ?? ""));

  const knownFields = $derived([
    "amount",
    "dueDate",
    "reference",
    "status",
    ...billStatuses.map((s) => `statusValue_${s}`),
  ]);

  function optionsFor(fields: CustomField[], types: readonly string[]) {
    return fields.filter((f) => types.includes(f.dataType));
  }
</script>

{#snippet fieldOptions(
  options: CustomField[],
  current: number | null,
  missing: boolean,
)}
  <NativeSelect.Option value="">Not mapped</NativeSelect.Option>
  {#if missing}
    <NativeSelect.Option value={String(current)}>
      Field #{current} (not suitable or not found)
    </NativeSelect.Option>
  {/if}
  {#each options as f (f.id)}
    <NativeSelect.Option value={String(f.id)}>
      {f.name} ({TYPE_LABELS[f.dataType] ?? f.dataType})
    </NativeSelect.Option>
  {/each}
{/snippet}

<Card.Root>
  <Card.Header>
    <Card.Title>Custom fields</Card.Title>
    <Card.Description>
      Optional. Kept writes the amount, due date, reference and status of each
      bill into these Paperless custom fields. Leave a field unmapped to skip
      it.
    </Card.Description>
  </Card.Header>
  <Card.Content>
    <form
      method="POST"
      action="?/setMapping"
      class="grid grid-cols-[minmax(0,1fr)] gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields,
        successMessage: "Field mapping saved.",
      })}
    >
      <FormAlert message={formError(errors)} />

      {#await lookups}
        <div class="grid gap-4 sm:grid-cols-2">
          {#each targets as t (t.key)}
            <Skeleton class="h-16 w-full" />
          {/each}
        </div>
        <p class="text-muted-foreground text-xs">Loading from Paperless…</p>
      {:then lists}
        {@const fields = lists.customFields}
        {#if lists.errors.customFields}
          <p class="text-muted-foreground text-sm">
            Could not load the custom fields from Paperless ({lists.errors
              .customFields}). Enter the numeric field ids by hand; they are
            shown in the Paperless admin under Custom fields.
          </p>
        {:else if fields && fields.length === 0}
          <p class="text-muted-foreground text-sm">
            Paperless has no custom fields yet. Create them in Paperless first,
            then come back here.
          </p>
        {/if}

        <div class="grid gap-4 sm:grid-cols-2">
          {#each targets as t (t.key)}
            {@const current = mapping[t.key] ?? null}
            <FormField
              class="[&_[data-slot=native-select-wrapper]]:w-full"
              label={t.label}
              for="map-{t.key}"
              errors={errors[t.key]}
              hint={t.hint}
            >
              {#if fields}
                {@const options = optionsFor(fields, t.types)}
                {@const missing =
                  current !== null && !options.some((f) => f.id === current)}
                {#if t.key === "status"}
                  <NativeSelect.Root
                    id="map-{t.key}"
                    name={t.key}
                    bind:value={statusField}
                    class="w-full"
                    aria-invalid={!!errors[t.key]}
                  >
                    {@render fieldOptions(options, current, missing)}
                  </NativeSelect.Root>
                {:else}
                  <NativeSelect.Root
                    id="map-{t.key}"
                    name={t.key}
                    value={current === null ? "" : String(current)}
                    class="w-full"
                    aria-invalid={!!errors[t.key]}
                  >
                    {@render fieldOptions(options, current, missing)}
                  </NativeSelect.Root>
                {/if}
              {:else if t.key === "status"}
                <Input
                  id="map-{t.key}"
                  name={t.key}
                  type="text"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  placeholder="Field id"
                  bind:value={statusField}
                  aria-invalid={!!errors[t.key]}
                />
              {:else}
                <Input
                  id="map-{t.key}"
                  name={t.key}
                  type="text"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  placeholder="Field id"
                  value={current === null ? "" : String(current)}
                  aria-invalid={!!errors[t.key]}
                />
              {/if}
            </FormField>
          {/each}
        </div>

        {#if statusField !== ""}
          {#key statusField}
            {@const field = fields?.find((f) => String(f.id) === statusField)}
            <fieldset class="grid gap-3 rounded-md border p-3 sm:p-4">
              <legend class="px-1 text-sm font-medium">Status values</legend>
              <p class="text-muted-foreground text-xs">
                {#if field?.dataType === "select"}
                  Choose the option to write for each Kept status.
                {:else}
                  Enter the text to write for each Kept status{fields
                    ? ""
                    : " (for a selection field, the option id)"}.
                {/if}
                If you fill none in, the status name is written as it is; if you fill
                some in, statuses left empty are not written.
              </p>
              <div class="grid gap-3 sm:grid-cols-2">
                {#each billStatuses as status (status)}
                  {@const saved = mapping.statusValues?.[status] ?? ""}
                  <FormField
                    label={STATUS_LABELS[status]}
                    for="statusValue_{status}"
                    errors={errors[`statusValue_${status}`]}
                  >
                    {#if field?.dataType === "select"}
                      <NativeSelect.Root
                        id="statusValue_{status}"
                        name="statusValue_{status}"
                        value={saved}
                        class="w-full"
                      >
                        <NativeSelect.Option value=""
                          >Do not write</NativeSelect.Option
                        >
                        {#if saved !== "" && !field.options.some((o) => o.id === saved)}
                          <NativeSelect.Option value={saved}>
                            {saved} (unknown option)
                          </NativeSelect.Option>
                        {/if}
                        {#each field.options as o (o.id)}
                          <NativeSelect.Option value={o.id}>
                            {o.label}
                          </NativeSelect.Option>
                        {/each}
                      </NativeSelect.Root>
                    {:else}
                      <Input
                        id="statusValue_{status}"
                        name="statusValue_{status}"
                        type="text"
                        maxlength={128}
                        value={saved}
                        placeholder={STATUS_LABELS[status]}
                        aria-invalid={!!errors[`statusValue_${status}`]}
                      />
                    {/if}
                  </FormField>
                {/each}
              </div>
            </fieldset>
          {/key}
        {/if}
      {/await}

      <Button type="submit" disabled={pending} class="self-start">
        {#if pending}<Spinner />Saving…{:else}Save mapping{/if}
      </Button>
    </form>
  </Card.Content>
</Card.Root>
