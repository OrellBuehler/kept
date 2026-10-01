<script lang="ts">
  import { categoryIcon } from "$lib/components/category-icons";
  import { cn } from "$lib/utils";

  let {
    name,
    color = null,
    icon = null,
    class: className,
  }: {
    name: string;
    color?: string | null;
    icon?: string | null;
    class?: string;
  } = $props();

  const Icon = $derived(categoryIcon(icon));
</script>

<span class={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
  <span
    class="bg-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full text-white"
    style:background-color={color}
    aria-hidden="true"
  >
    <Icon class="size-3" />
  </span>
  <span class="truncate">{name}</span>
</span>
