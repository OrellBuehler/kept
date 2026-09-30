<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import type { BillStatusName } from "$lib/bill-types";
  import { STATUS_CLASSES, STATUS_LABELS } from "$lib/bill-display";
  import { cn } from "$lib/utils";

  let { status, class: className }: { status: BillStatusName; class?: string } =
    $props();
</script>

<Badge variant="outline" class={cn(STATUS_CLASSES[status], className)}>
  {STATUS_LABELS[status]}
</Badge>
