<script lang="ts">
  import { NativeSelect } from "$lib/components/ui/native-select";
  import FormField from "$lib/components/FormField.svelte";
  import type { DetectedColumn } from "$lib/server/importers/csv";

  let {
    id,
    label,
    value = $bindable(""),
    detected,
    byIndex,
    required = false,
    disabled = false,
  }: {
    id: string;
    label: string;
    /** Column name, or the 0-based index as a string when the file has no header. */
    value: string;
    detected: DetectedColumn[];
    byIndex: boolean;
    required?: boolean;
    disabled?: boolean;
  } = $props();

  const key = (c: DetectedColumn) => (byIndex ? String(c.index) : c.name);
  const matches = (c: DetectedColumn) =>
    key(c).trim().toLowerCase() === value.trim().toLowerCase();

  const current = $derived(value === "" ? undefined : detected.find(matches));
  const unknown = $derived(value !== "" && current === undefined);
  $effect(() => {
    if (current && key(current) !== value) value = key(current);
  });

  const sample = $derived(current?.samples.filter((s) => s !== "").join(" · "));
</script>

<FormField
  {label}
  for={id}
  hint={sample ? `e.g. ${sample}` : undefined}
  errors={unknown ? ["This column is not in the file."] : undefined}
>
  <NativeSelect
    {id}
    bind:value
    {disabled}
    class="w-full"
    aria-invalid={unknown}
  >
    <option value="">{required ? "Choose a column" : "— none —"}</option>
    {#if unknown}
      <option {value}>{value}</option>
    {/if}
    {#each detected as column (column.index)}
      <option value={key(column)}>
        {byIndex
          ? `Column ${column.index + 1}`
          : column.name || `Column ${column.index + 1}`}
      </option>
    {/each}
  </NativeSelect>
</FormField>
