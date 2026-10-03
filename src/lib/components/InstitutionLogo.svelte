<script lang="ts">
  import {
    avatarClass,
    institutionInitials,
    logoUrl,
  } from "$lib/institution-logo";
  import { cn } from "$lib/utils";

  let {
    institution,
    size = "md",
    class: className,
  }: {
    institution: {
      id: string;
      name: string;
      color?: string | null;
      logoVersion?: string | null;
    };
    size?: "sm" | "md" | "lg";
    class?: string;
  } = $props();

  const box = $derived(
    { sm: "size-5 text-[9px]", md: "size-8 text-xs", lg: "size-12 text-base" }[
      size
    ],
  );
  const src = $derived(
    institution.logoVersion
      ? logoUrl(institution.id, institution.logoVersion)
      : null,
  );

  let failedSrc = $state<string | null>(null);
  const failed = $derived(src !== null && failedSrc === src);
</script>

{#if src && !failed}
  <img
    {src}
    alt=""
    loading="lazy"
    class={cn(
      "bg-background shrink-0 rounded-md border object-contain p-0.5",
      box,
      className,
    )}
    onerror={() => (failedSrc = src)}
  />
{:else}
  <span
    aria-hidden="true"
    class={cn(
      "flex shrink-0 items-center justify-center rounded-md font-semibold text-white select-none",
      box,
      !institution.color && avatarClass(institution.name),
      className,
    )}
    style:background-color={institution.color}
  >
    {institutionInitials(institution.name)}
  </span>
{/if}
