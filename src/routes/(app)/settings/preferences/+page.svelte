<script lang="ts">
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { toast } from "svelte-sonner";
  import * as Card from "$lib/components/ui/card/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import * as RadioGroup from "$lib/components/ui/radio-group/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import { COMMON_CURRENCIES } from "$lib/account-types";
  import { fieldErrors, formError } from "$lib/form-errors";
  import { formatAmount, minor } from "$lib/money";
  import { formatDate } from "$lib/format";
  import { LOCALES, PAGE_SIZES, type IbanDisplay } from "$lib/preferences";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  let pending = $state(false);

  // Local draft of the form; re-seeded when the saved preferences change.
  let ibanDisplay = $derived<IbanDisplay>(data.preferences.ibanDisplay);
  let blurAmounts = $derived(data.preferences.blurAmounts);
  let locale = $derived<string>(data.preferences.locale);
  let investmentCashLiquid = $derived(data.preferences.investmentCashLiquid);

  const IBAN_OPTIONS: { value: IbanDisplay; label: string; hint: string }[] = [
    { value: "full", label: "Full", hint: "Show the whole IBAN." },
    {
      value: "masked",
      label: "Masked",
      hint: "Show only the country code, check digits and last four characters.",
    },
    { value: "hidden", label: "Hidden", hint: "Never show IBANs." },
  ];

  const LOCALE_LABELS: Record<(typeof LOCALES)[number], string> = {
    "en-GB": "English (UK)",
    "de-CH": "Deutsch (Schweiz)",
    "de-DE": "Deutsch (Deutschland)",
    "fr-CH": "Français (Suisse)",
    "en-US": "English (US)",
  };

  const sample = $derived(
    `${formatAmount(minor(123450), "CHF", locale)} · ${formatDate("2024-03-31", locale)}`,
  );
</script>

<svelte:head>
  <title>Preferences · Kept</title>
</svelte:head>

<h1 class="mb-6 text-2xl font-semibold tracking-tight md:text-3xl">
  Preferences
</h1>

<form
  method="POST"
  action="?/save"
  class="grid max-w-xl gap-6"
  use:enhance={() => {
    pending = true;
    return async ({ result, update }) => {
      await update({ reset: false });
      pending = false;
      if (result.type === "success") {
        await invalidateAll();
        toast.success("Preferences saved.");
      } else if (result.type === "error") {
        toast.error("Something went wrong. Please try again.");
      }
    };
  }}
>
  <FormAlert message={formError(form?.errors)} />

  <Card.Root>
    <Card.Header>
      <Card.Title>Privacy</Card.Title>
      <Card.Description>
        Control how sensitive details are shown on screen.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Field.Group>
        <Field.Set>
          <Field.Legend variant="label">IBAN display</Field.Legend>
          <RadioGroup.Root
            name="ibanDisplay"
            bind:value={ibanDisplay}
            class="gap-3"
          >
            {#each IBAN_OPTIONS as option (option.value)}
              <Field.Field orientation="horizontal">
                <RadioGroup.Item
                  value={option.value}
                  id="iban-{option.value}"
                />
                <Field.Content>
                  <Field.Label for="iban-{option.value}"
                    >{option.label}</Field.Label
                  >
                  <Field.Description>{option.hint}</Field.Description>
                </Field.Content>
              </Field.Field>
            {/each}
          </RadioGroup.Root>
          <Field.Description>
            Masked and hidden only change what is displayed on screen. Your
            stored data and imports are not affected.
          </Field.Description>
          <Field.Error errors={fieldErrors(form?.errors, "ibanDisplay")} />
        </Field.Set>

        <Field.Field orientation="horizontal">
          <Field.Content>
            <Field.Label for="blurAmounts">Blur amounts</Field.Label>
            <Field.Description>
              Amounts are blurred until you hover over or focus them. You can
              also toggle this with the eye button in the header.
            </Field.Description>
          </Field.Content>
          <Switch
            id="blurAmounts"
            name="blurAmounts"
            bind:checked={blurAmounts}
          />
        </Field.Field>
      </Field.Group>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Display</Card.Title>
      <Card.Description>
        Numbers and dates in the app. PDF reports keep their own format.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Field.Group>
        <Field.Field>
          <Label for="locale">Number and date format</Label>
          <NativeSelect id="locale" name="locale" bind:value={locale}>
            {#each LOCALES as l (l)}
              <option value={l}>{LOCALE_LABELS[l]}</option>
            {/each}
          </NativeSelect>
          <Field.Description>Example: {sample}</Field.Description>
          <Field.Error errors={fieldErrors(form?.errors, "locale")} />
        </Field.Field>

        <Field.Field>
          <Label for="defaultCurrency">Default currency</Label>
          <NativeSelect
            id="defaultCurrency"
            name="defaultCurrency"
            value={data.preferences.defaultCurrency}
          >
            {#each COMMON_CURRENCIES as c (c)}
              <option value={c}>{c}</option>
            {/each}
          </NativeSelect>
          <Field.Description>
            Pre-filled when you add an account, bill or budget.
          </Field.Description>
          <Field.Error errors={fieldErrors(form?.errors, "defaultCurrency")} />
        </Field.Field>

        <Field.Field>
          <Label for="pageSize">Transactions per page</Label>
          <NativeSelect
            id="pageSize"
            name="pageSize"
            value={String(data.preferences.pageSize)}
          >
            {#each PAGE_SIZES as n (n)}
              <option value={String(n)}>{n}</option>
            {/each}
          </NativeSelect>
          <Field.Error errors={fieldErrors(form?.errors, "pageSize")} />
        </Field.Field>
      </Field.Group>
    </Card.Content>
  </Card.Root>

  <Card.Root>
    <Card.Header>
      <Card.Title>Liquidity</Card.Title>
      <Card.Description>
        What counts towards liquid cash on the dashboard.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <Field.Field orientation="horizontal">
        <Field.Content>
          <Field.Label for="investmentCashLiquid">
            Count cash in investment accounts as liquid
          </Field.Label>
          <Field.Description>
            Securities never count as liquid cash. Pension and pillar 3a
            accounts are always left out.
          </Field.Description>
        </Field.Content>
        <Switch
          id="investmentCashLiquid"
          name="investmentCashLiquid"
          bind:checked={investmentCashLiquid}
        />
      </Field.Field>
    </Card.Content>
  </Card.Root>

  <Button type="submit" disabled={pending} class="justify-self-start">
    {#if pending}<Spinner />Saving…{:else}Save preferences{/if}
  </Button>
</form>
