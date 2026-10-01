<script lang="ts">
  import { enhance } from "$app/forms";
  import { toast } from "svelte-sonner";
  import * as NativeSelect from "$lib/components/ui/native-select";
  import { categoryLabel, type CategoryOption } from "$lib/category-types";
  import { cn } from "$lib/utils";

  let {
    transactionId,
    categoryId,
    categories,
    class: className,
  }: {
    transactionId: string;
    categoryId: string | null;
    categories: CategoryOption[];
    class?: string;
  } = $props();

  let form = $state<HTMLFormElement>();
  let pending = $state(false);
</script>

<form
  bind:this={form}
  method="POST"
  action="?/setCategory"
  class={cn("w-full", className)}
  use:enhance={() => {
    pending = true;
    return async ({ result, update }) => {
      pending = false;
      if (result.type === "success") {
        await update({ reset: false });
      } else {
        toast.error("Could not change the category. Please try again.");
        await update({ reset: false, invalidateAll: true });
      }
    };
  }}
>
  <input type="hidden" name="transactionId" value={transactionId} />
  <NativeSelect.Root
    name="categoryId"
    aria-label="Category"
    class="h-8 w-full text-xs"
    value={categoryId ?? ""}
    disabled={pending}
    onclick={(e) => e.stopPropagation()}
    onchange={() => form?.requestSubmit()}
  >
    <NativeSelect.Option value="">Uncategorized</NativeSelect.Option>
    {#each categories as c (c.id)}
      <NativeSelect.Option value={c.id}>
        {categoryLabel(c, categories)}
      </NativeSelect.Option>
    {/each}
  </NativeSelect.Root>
</form>
