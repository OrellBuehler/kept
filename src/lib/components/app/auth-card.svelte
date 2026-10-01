<script lang="ts">
  import type { Snippet } from "svelte";
  import Logo from "./logo.svelte";

  let { children }: { children: Snippet } = $props();
</script>

<main
  class="relative flex min-h-svh items-center justify-center overflow-hidden p-4"
>
  <div
    aria-hidden="true"
    class="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_15%_0%,hsl(var(--brand)/0.16),transparent),radial-gradient(50%_45%_at_90%_100%,hsl(var(--chart-2)/0.12),transparent)]"
  ></div>
  <div
    aria-hidden="true"
    class="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(hsl(var(--foreground)/0.04)_1px,transparent_1px),linear-gradient(90deg,hsl(var(--foreground)/0.04)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)] bg-[size:40px_40px]"
  ></div>
  <div
    class="animate-in fade-in slide-in-from-bottom-2 flex w-full max-w-sm flex-col gap-6 duration-500 motion-reduce:animate-none"
  >
    <div class="flex flex-col items-center gap-2">
      <Logo class="h-10 self-center" />
      <p class="text-muted-foreground text-sm">
        Your accounts, bills and payments, kept in one place.
      </p>
    </div>
    <div
      class="glass shadow-raised rounded-xl [&_[data-slot=card]]:bg-transparent [&_[data-slot=card]]:shadow-none"
    >
      {@render children()}
    </div>
  </div>
</main>
