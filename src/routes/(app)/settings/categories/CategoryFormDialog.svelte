<script lang="ts">
  import { enhance } from "$app/forms";
  import { untrack } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Spinner } from "$lib/components/ui/spinner";
  import FormField from "$lib/components/FormField.svelte";
  import { categoryIcon } from "$lib/components/category-icons";
  import { COLOR_PALETTE } from "$lib/account-types";
  import {
    CATEGORY_ICONS,
    CATEGORY_KINDS,
    type CategoryKind,
  } from "$lib/category-types";
  import type { FormErrors } from "$lib/form-errors";
  import { submitHandler } from "$lib/form-submit";
  import { cn } from "$lib/utils";
  import CheckIcon from "@lucide/svelte/icons/check";

  interface Editable {
    id: string;
    name: string;
    parentId: string | null;
    kind: CategoryKind;
    color: string | null;
    icon: string | null;
  }

  let {
    open = $bindable(false),
    category = null,
    topLevel,
  }: {
    open?: boolean;
    category?: Editable | null;
    /** Categories that can be chosen as a parent. */
    topLevel: { id: string; name: string; kind: CategoryKind }[];
  } = $props();

  const uid = $props.id();
  let pending = $state(false);
  let errors = $state<NonNullable<FormErrors>>({});
  let kind = $state<CategoryKind>("expense");
  let parentId = $state("");
  let color = $state("");
  let icon = $state("");

  $effect(() => {
    if (!open) return;
    untrack(() => {
      errors = {};
      kind = category?.kind ?? "expense";
      parentId = category?.parentId ?? "";
      color = category?.color ?? "";
      icon = category?.icon ?? "";
    });
  });

  const editing = $derived(category !== null);
  const parents = $derived(
    topLevel.filter((p) => p.id !== category?.id && p.kind === kind),
  );
  $effect(() => {
    if (parentId && !parents.some((p) => p.id === parentId)) parentId = "";
  });
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-h-[90dvh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>{editing ? "Edit category" : "Add category"}</Dialog.Title>
      <Dialog.Description>
        Group transactions to see where your money goes.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action={editing ? "?/updateCategory" : "?/createCategory"}
      class="grid gap-4"
      use:enhance={submitHandler({
        setPending: (v) => (pending = v),
        setErrors: (e) => (errors = e),
        knownFields: ["name", "kind", "parentId", "color", "icon"],
        successMessage: editing ? "Category updated" : "Category added",
        onSuccess: () => (open = false),
      })}
    >
      {#if category}
        <input type="hidden" name="id" value={category.id} />
      {/if}
      <FormField label="Name" for="{uid}-name" errors={errors.name}>
        <Input
          id="{uid}-name"
          name="name"
          required
          maxlength={60}
          placeholder="Groceries"
          value={category?.name ?? ""}
          aria-invalid={!!errors.name}
        />
      </FormField>
      <div class="grid gap-4 sm:grid-cols-2">
        <FormField label="Type" for="{uid}-kind" errors={errors.kind}>
          <NativeSelect.Root
            id="{uid}-kind"
            name="kind"
            class="w-full"
            bind:value={kind}
          >
            {#each CATEGORY_KINDS as k (k)}
              <NativeSelect.Option value={k}>
                {k === "expense" ? "Expense" : "Income"}
              </NativeSelect.Option>
            {/each}
          </NativeSelect.Root>
        </FormField>
        <FormField
          label="Parent (optional)"
          for="{uid}-parent"
          errors={errors.parentId}
        >
          <NativeSelect.Root
            id="{uid}-parent"
            name="parentId"
            class="w-full"
            bind:value={parentId}
          >
            <NativeSelect.Option value="">None</NativeSelect.Option>
            {#each parents as p (p.id)}
              <NativeSelect.Option value={p.id}>{p.name}</NativeSelect.Option>
            {/each}
          </NativeSelect.Root>
        </FormField>
      </div>
      <div class="grid gap-1.5">
        <span class="text-sm leading-none font-medium">Colour</span>
        <input type="hidden" name="color" value={color} />
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class={cn(
              "text-muted-foreground flex h-7 items-center rounded-full border px-2.5 text-xs",
              color === "" && "border-foreground text-foreground",
            )}
            aria-pressed={color === ""}
            onclick={() => (color = "")}
          >
            None
          </button>
          {#each COLOR_PALETTE as swatch (swatch)}
            <button
              type="button"
              class={cn(
                "flex size-7 items-center justify-center rounded-full border-2 border-transparent text-white",
                color === swatch && "border-foreground",
              )}
              style:background-color={swatch}
              aria-label="Colour {swatch}"
              aria-pressed={color === swatch}
              onclick={() => (color = swatch)}
            >
              {#if color === swatch}<CheckIcon class="size-3.5" />{/if}
            </button>
          {/each}
        </div>
        {#if errors.color?.length}
          <p class="text-destructive text-sm" role="alert">{errors.color[0]}</p>
        {/if}
      </div>
      <div class="grid gap-1.5">
        <span class="text-sm leading-none font-medium">Icon</span>
        <input type="hidden" name="icon" value={icon} />
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class={cn(
              "text-muted-foreground flex h-8 items-center rounded-md border px-2.5 text-xs",
              icon === "" && "border-foreground text-foreground",
            )}
            aria-pressed={icon === ""}
            onclick={() => (icon = "")}
          >
            Default
          </button>
          {#each CATEGORY_ICONS as name (name)}
            {@const Icon = categoryIcon(name)}
            <button
              type="button"
              class={cn(
                "text-muted-foreground flex size-8 items-center justify-center rounded-md border",
                icon === name && "border-foreground text-foreground",
              )}
              aria-label="Icon {name}"
              aria-pressed={icon === name}
              onclick={() => (icon = name)}
            >
              <Icon class="size-4" />
            </button>
          {/each}
        </div>
        {#if errors.icon?.length}
          <p class="text-destructive text-sm" role="alert">{errors.icon[0]}</p>
        {/if}
      </div>
      {#if errors.form?.length}
        <p class="text-destructive text-sm" role="alert">
          {errors.form.join(" ")}
        </p>
      {/if}
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => (open = false)}
          disabled={pending}>Cancel</Button
        >
        <Button type="submit" disabled={pending}>
          {#if pending}<Spinner />{/if}
          {editing ? "Save" : "Add category"}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
