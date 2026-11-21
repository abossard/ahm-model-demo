import { useState } from "react";
import type { FormEvent, JSX } from "react";
import {
  Button, Field, Input, MessageBar, MessageBarBody, Radio, RadioGroup, Select, Spinner, Text, makeStyles, mergeClasses, shorthands, tokens,
} from "@fluentui/react-components";
import { Building20Regular, ChevronDown16Regular, ChevronUp16Regular } from "@fluentui/react-icons";
import type { AzureDirectory } from "../auth";
import { DirectoryError, resolveDirectory, tenantFromLink } from "../auth/directory";
import { signInHint } from "../model/errors";
import { actions, useStore } from "../store/store";

const useStyles = makeStyles({
  form: { display: "grid", gap: tokens.spacingVerticalM, width: "100%", minWidth: 0 },
  group: { display: "grid", gap: tokens.spacingVerticalXS, maxHeight: "40vh", overflowY: "auto", padding: "2px" },
  option: {
    padding: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    ":hover": { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  selected: { ...shorthands.borderColor(tokens.colorBrandStroke1), backgroundColor: tokens.colorBrandBackground2 },
  label: { display: "flex", gap: tokens.spacingHorizontalM, alignItems: "center", overflowWrap: "anywhere" },
  names: { display: "grid", gap: "2px" },
  muted: { color: tokens.colorNeutralForeground2, overflowWrap: "anywhere" },
  footer: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: tokens.spacingHorizontalM },
  manual: { justifySelf: "start", paddingLeft: 0, color: tokens.colorBrandForeground1 },
  discovery: { display: "grid", justifyItems: "start", gap: tokens.spacingVerticalS, paddingTop: tokens.spacingVerticalS },
  error: { overflowWrap: "anywhere" },
});

export function DirectoryChooser(): JSX.Element {
  const styles = useStyles();
  const account = useStore((state) => state.account);
  const listing = useStore((state) => state.directoryList);
  const authError = useStore((state) => state.authError);
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState<boolean | null>(null);
  const [showOther, setShowOther] = useState<boolean | null>(null);
  const [lookupTenant, setLookupTenant] = useState<string | null>(null);
  const linkTenant = tenantFromLink(window.location.search);
  const [input, setInput] = useState(linkTenant ?? "");
  const [validation, setValidation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const verified = listing.status === "available" ? listing.directories : [];
  const needsCheck = listing.status === "available" ? listing.needsCheck ?? [] : [];
  const sources = listing.status === "available" ? listing.discoverySources ?? [] : [];
  const lookupSource = sources.find(source => source.tenantId === lookupTenant) ?? sources[0];
  const directories = [...verified, ...needsCheck];
  const empty = listing.status === "available" && directories.length === 0;
  const manualOpen = empty || (manual ?? (listing.status === "error" && Boolean(linkTenant)));
  const linkedDirectory = directories.find(item => item.tenantId === linkTenant);
  const selectedId = selected ?? linkedDirectory?.tenantId ?? (verified.length === 1 && !linkTenant ? verified[0]!.tenantId : "");
  const chosen = directories.find((directory) => directory.tenantId === selectedId);
  const chosenNeedsCheck = needsCheck.some(directory => directory.tenantId === selectedId);
  const otherOpen = showOther ?? (verified.length === 0 || needsCheck.some(directory => directory.tenantId === linkTenant));

  function selectOption(tenantId: string): void {
    setSelected(tenantId);
    setManual(false);
    setValidation(null);
  }

  function renderOption(directory: AzureDirectory): JSX.Element {
    const label = directory.defaultDomain ?? directory.tenantId;
    return <Radio key={directory.tenantId} value={directory.tenantId}
      className={mergeClasses(styles.option, !manualOpen && selectedId === directory.tenantId && styles.selected)}
      label={<span className={styles.label}><Building20Regular aria-hidden="true" /><span className={styles.names}>
        <Text weight="semibold">{directory.displayName}</Text>
        {directory.displayName !== label && <Text size={200} className={styles.muted}>{label}</Text>}
      </span></span>}
    />;
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setValidation(null);
    setBusy(true);
    try {
      if (manualOpen) {
        const tenantId = input === linkTenant ? input : await resolveDirectory(input);
        const directory = directories.find((item) => item.tenantId === tenantId || item.defaultDomain?.toLowerCase() === tenantId);
        await actions.selectDirectory(directory ?? { tenantId, displayName: tenantId });
      } else if (chosen) {
        await actions.selectDirectory(chosen);
      }
    } catch (error) {
      setValidation(error instanceof DirectoryError ? error.message : "The directory could not be opened. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} data-testid="directory-chooser">
      <Text as="h1" size={700} weight="semibold">Choose your Azure directory</Text>
      <Text className={styles.muted}>
        Signed in as <strong>{account?.username}</strong>. Choose where to open your workspace. To change directories later, sign out.
      </Text>
      {linkTenant && <Text size={200} className={styles.muted}>
        This link opens {linkedDirectory?.displayName ?? linkTenant}.
      </Text>}
      {authError && <MessageBar intent="error" role="alert" className={styles.error} data-testid="directory-error">
        <MessageBarBody>{signInHint(authError) ?? "The directory request could not be completed. Try again or enter another directory you belong to."}
          <details><summary>Directory error details</summary>{authError}</details>
        </MessageBarBody>
      </MessageBar>}
      {listing.status === "loading" && <Spinner size="small" label="Checking workspace access in your Azure directories…" data-testid="directory-loading" />}
      {listing.status === "error" && <MessageBar intent="warning" data-testid="directory-lookup-error">
        <MessageBarBody>Azure could not verify directory access. Retry the check or enter a directory manually.
          <details><summary>Lookup details</summary>{listing.message}</details>
          <Button type="button" size="small" disabled={busy} onClick={() => void actions.loadDirectories()}>Retry lookup</Button>
        </MessageBarBody>
      </MessageBar>}
      {empty && <Text className={styles.muted} role="status" data-testid="directory-empty">
        We couldn’t confirm workspace access in any directory. You can check a directory where you are a member or guest.
      </Text>}
      {listing.status === "available" && listing.discoveredCount !== undefined && listing.discoveredCount > verified.length &&
        <Text size={200} className={styles.muted} data-testid="directory-coverage">
          Workspace access verified in {verified.length} of {listing.discoveredCount} Azure {listing.discoveredCount === 1 ? "directory" : "directories"}.
        </Text>}
      {verified.length > 0 && <>
        <Text as="h2" size={400} weight="semibold" id="directory-options-heading">Directories with verified access</Text>
        <RadioGroup aria-labelledby="directory-options-heading" data-testid="directory-options" className={styles.group} disabled={busy}
          value={manualOpen ? "" : selectedId} onChange={(_, data) => selectOption(data.value)}
        >
          {verified.map(renderOption)}
        </RadioGroup>
      </>}
      {needsCheck.length > 0 && <>
        <Button type="button" appearance="transparent" className={styles.manual} disabled={busy}
          icon={otherOpen ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
          aria-expanded={otherOpen} aria-controls={otherOpen ? "directory-verification-options" : undefined} data-testid="directory-verification-toggle"
          onClick={() => setShowOther(!otherOpen)}
        >{verified.length ? "More Azure directories" : "Azure directories to check"} ({needsCheck.length}){!otherOpen && !manualOpen && chosenNeedsCheck && ` · ${chosen?.displayName}`}</Button>
        {otherOpen && <>
          <Text size={200} className={styles.muted}>These directories still need an access check. Microsoft may ask you to sign in or approve access.</Text>
          <RadioGroup id="directory-verification-options" aria-label="Directories to check" data-testid="directory-verification-options"
            className={styles.group} disabled={busy} value={manualOpen ? "" : selectedId} onChange={(_, data) => selectOption(data.value)}>
            {needsCheck.map(renderOption)}
          </RadioGroup>
        </>}
      </>}
      {listing.status === "available" && listing.incomplete && <MessageBar intent="warning" data-testid="directory-incomplete">
        <MessageBarBody>Some directory checks could not finish. You can retry the check or enter a directory manually.
          <Button type="button" size="small" disabled={busy} onClick={() => void actions.loadDirectories()}>Retry lookup</Button>
        </MessageBarBody>
      </MessageBar>}
      {listing.status === "available" && listing.consentRequired && <details data-testid="directory-discovery-options">
        <summary>Find more directories</summary>
        <div className={styles.discovery}>
          {sources.length > 1 && <Field label={{ children: "Directory for lookup", htmlFor: "directory-discovery-source" }}
            hint="If your sign-in directory requires admin approval, try a directory where you’re a guest. You’ll choose your workspace after the lookup.">
            <Select id="directory-discovery-source" data-testid="directory-discovery-source" disabled={busy}
              value={lookupSource?.tenantId} onChange={(_, data) => setLookupTenant(data.value)}>
              {sources.map(source => <option key={source.tenantId} value={source.tenantId}>{source.displayName}</option>)}
            </Select>
          </Field>}
          <Text size={200} className={styles.muted}>
            {sources.length === 1 ? `Microsoft may ask for permission in ${lookupSource?.displayName} to list your Azure directories.`
              : "Microsoft may ask for permission to list your Azure directories."}
          </Text>
          <Button type="button" size="small" disabled={busy} data-testid="directory-consent"
            onClick={() => void actions.loadDirectories(true, lookupSource?.tenantId)}>Continue to Microsoft</Button>
        </div>
      </details>}
      {!empty && <Button type="button" appearance="transparent" size="small" className={styles.manual}
        icon={manualOpen ? <ChevronUp16Regular /> : <ChevronDown16Regular />} disabled={busy}
        aria-expanded={manualOpen} onClick={() => { setManual(!manualOpen); setValidation(null); }} data-testid="directory-toggle"
      >Enter a directory manually</Button>}
      {manualOpen && <Field label="Directory domain, directory ID or subscription ID"
        hint="Microsoft may ask for verification or approval before this workspace opens."
        validationState={validation ? "error" : "none"} validationMessage={validation}>
        <Input value={input} disabled={busy} onChange={(_, data) => { setInput(data.value); setValidation(null); }}
          placeholder="e.g. contoso.onmicrosoft.com" autoComplete="off" spellCheck={false} data-testid="directory-input" />
      </Field>}
      <div className={styles.footer}>
        <Button type="button" appearance="subtle" disabled={busy} data-testid="sign-out"
          onClick={() => void actions.signOut()}>Sign out</Button>
        <Button appearance="primary" type="submit" data-testid="directory-continue"
          disabled={busy || (manualOpen ? !input.trim() : !chosen)}>{busy ? "Opening workspace…" : manualOpen || chosenNeedsCheck ? "Check and open workspace" : "Open workspace"}</Button>
      </div>
    </form>
  );
}
