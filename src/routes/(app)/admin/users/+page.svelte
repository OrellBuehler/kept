<script lang="ts">
  import { enhance } from "$app/forms";
  import { toast } from "svelte-sonner";
  import UserPlusIcon from "@lucide/svelte/icons/user-plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import * as Table from "$lib/components/ui/table/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as AlertDialog from "$lib/components/ui/alert-dialog/index.js";
  import * as Field from "$lib/components/ui/field/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import {
    NativeSelect,
    NativeSelectOption,
  } from "$lib/components/ui/native-select/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Spinner } from "$lib/components/ui/spinner/index.js";
  import FormAlert from "$lib/components/app/form-alert.svelte";
  import { fieldErrors, formError, hasError } from "$lib/form-errors";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();

  const me = $derived(data.user.id);

  let addOpen = $state(false);
  let adding = $state(false);
  let deleteTarget = $state<(typeof data.users)[number] | null>(null);
  let deleting = $state(false);
  let lastTarget = $state<(typeof data.users)[number] | null>(null);

  const createFailure = $derived(form && "values" in form ? form : null);
  const formatDate = (d: Date) => d.toISOString().slice(0, 10);
</script>

<svelte:head>
  <title>Users · Kept</title>
</svelte:head>

<div class="mb-6 flex flex-wrap items-center justify-between gap-3">
  <h1 class="text-2xl font-semibold tracking-tight">Users</h1>
  <Button onclick={() => (addOpen = true)}>
    <UserPlusIcon />
    Add user
  </Button>
</div>

{#snippet roleBadge(role: string)}
  <Badge variant={role === "admin" ? "default" : "secondary"}>
    {role === "admin" ? "Admin" : "Member"}
  </Badge>
{/snippet}

{#snippet deleteButton(user: (typeof data.users)[number])}
  {#if user.id !== me}
    <Button
      variant="ghost"
      size="icon"
      class="text-destructive hover:text-destructive"
      aria-label={`Delete ${user.username}`}
      onclick={() => (deleteTarget = lastTarget = user)}
    >
      <Trash2Icon />
    </Button>
  {/if}
{/snippet}

<div class="hidden md:block">
  <Card.Root class="py-0">
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Username</Table.Head>
          <Table.Head>Display name</Table.Head>
          <Table.Head>Role</Table.Head>
          <Table.Head>Created</Table.Head>
          <Table.Head class="w-12"
            ><span class="sr-only">Actions</span></Table.Head
          >
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.users as user (user.id)}
          <Table.Row>
            <Table.Cell class="font-medium">{user.username}</Table.Cell>
            <Table.Cell>
              {#if user.displayName}{user.displayName}{:else}<span
                  class="text-muted-foreground">—</span
                >{/if}
            </Table.Cell>
            <Table.Cell>{@render roleBadge(user.role)}</Table.Cell>
            <Table.Cell class="tabular-nums"
              >{formatDate(user.createdAt)}</Table.Cell
            >
            <Table.Cell class="text-end"
              >{@render deleteButton(user)}</Table.Cell
            >
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </Card.Root>
</div>

<ul class="grid gap-3 md:hidden">
  {#each data.users as user (user.id)}
    <li>
      <Card.Root class="py-4">
        <Card.Content class="flex items-center gap-3 px-4">
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium">{user.username}</p>
            {#if user.displayName}
              <p class="text-muted-foreground truncate text-sm">
                {user.displayName}
              </p>
            {/if}
            <div class="mt-2 flex items-center gap-2 text-xs">
              {@render roleBadge(user.role)}
              <span class="text-muted-foreground tabular-nums"
                >Created {formatDate(user.createdAt)}</span
              >
            </div>
          </div>
          {@render deleteButton(user)}
        </Card.Content>
      </Card.Root>
    </li>
  {/each}
</ul>

<Dialog.Root bind:open={addOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Add user</Dialog.Title>
      <Dialog.Description>
        Create a new account. The user can change the password after logging in.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action="?/create"
      class="flex flex-col gap-4"
      use:enhance={() => {
        adding = true;
        return async ({ result, update }) => {
          await update({ reset: result.type === "success" });
          adding = false;
          if (result.type === "success") {
            addOpen = false;
            toast.success(`Added user ${result.data?.username ?? ""}`.trim());
          } else if (result.type === "error") {
            toast.error("Could not add the user. Please try again.");
          }
        };
      }}
    >
      <FormAlert message={formError(createFailure?.errors)} />
      <Field.Group>
        <Field.Field>
          <Field.Label for="new-username">Username</Field.Label>
          <Input
            id="new-username"
            name="username"
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            required
            value={createFailure?.values?.username ?? ""}
            aria-invalid={hasError(createFailure?.errors, "username")}
          />
          <Field.Error
            errors={fieldErrors(createFailure?.errors, "username")}
          />
        </Field.Field>
        <Field.Field>
          <Field.Label for="new-displayName">
            Display name <span class="text-muted-foreground">(optional)</span>
          </Field.Label>
          <Input
            id="new-displayName"
            name="displayName"
            autocomplete="off"
            value={createFailure?.values?.displayName ?? ""}
            aria-invalid={hasError(createFailure?.errors, "displayName")}
          />
          <Field.Error
            errors={fieldErrors(createFailure?.errors, "displayName")}
          />
        </Field.Field>
        <Field.Field>
          <Field.Label for="new-password">Password</Field.Label>
          <Input
            id="new-password"
            name="password"
            type="password"
            autocomplete="new-password"
            required
            minlength={10}
            aria-invalid={hasError(createFailure?.errors, "password")}
          />
          <Field.Description>At least 10 characters.</Field.Description>
          <Field.Error
            errors={fieldErrors(createFailure?.errors, "password")}
          />
        </Field.Field>
        <Field.Field>
          <Field.Label for="new-role">Role</Field.Label>
          <NativeSelect
            id="new-role"
            name="role"
            class="w-full"
            value={createFailure?.values?.role ?? "member"}
          >
            <NativeSelectOption value="member">Member</NativeSelectOption>
            <NativeSelectOption value="admin">Admin</NativeSelectOption>
          </NativeSelect>
          <Field.Error errors={fieldErrors(createFailure?.errors, "role")} />
        </Field.Field>
      </Field.Group>
      <Dialog.Footer>
        <Button
          type="button"
          variant="outline"
          onclick={() => (addOpen = false)}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={adding}>
          {#if adding}<Spinner />Adding…{:else}Add user{/if}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>

<AlertDialog.Root
  open={deleteTarget !== null}
  onOpenChange={(o) => {
    if (!o && !deleting) deleteTarget = null;
  }}
>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete {lastTarget?.username}?</AlertDialog.Title>
      <AlertDialog.Description>
        This permanently removes the account and signs the user out everywhere.
        This cannot be undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    <form
      method="POST"
      action="?/delete"
      class="contents"
      use:enhance={() => {
        deleting = true;
        const name = lastTarget?.username;
        return async ({ result, update }) => {
          await update();
          deleting = false;
          if (result.type === "success") {
            toast.success(`Deleted user ${name ?? ""}`.trim());
          } else if (result.type === "failure") {
            const errors = result.data?.errors as
              Record<string, string[]> | undefined;
            toast.error(errors?.form?.[0] ?? "Could not delete the user.");
          } else if (result.type === "error") {
            toast.error("Could not delete the user. Please try again.");
          }
          deleteTarget = null;
        };
      }}
    >
      <input type="hidden" name="userId" value={lastTarget?.id ?? ""} />
      <AlertDialog.Footer>
        <AlertDialog.Cancel type="button" disabled={deleting}
          >Cancel</AlertDialog.Cancel
        >
        <Button type="submit" variant="destructive" disabled={deleting}>
          {#if deleting}<Spinner />Deleting…{:else}Delete user{/if}
        </Button>
      </AlertDialog.Footer>
    </form>
  </AlertDialog.Content>
</AlertDialog.Root>
