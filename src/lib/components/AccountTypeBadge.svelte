<script lang="ts">
  import { Badge } from "$lib/components/ui/badge";
  import { ACCOUNT_TYPE_LABELS } from "$lib/account-types";
  import type { AccountType } from "$lib/ledger-types";

  let { type, class: className }: { type: AccountType; class?: string } =
    $props();
</script>

<Badge variant="secondary" class={className}>{ACCOUNT_TYPE_LABELS[type]}</Badge>
