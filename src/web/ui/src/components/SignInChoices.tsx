import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { Button, Field, Input, Text, makeStyles, tokens } from "@fluentui/react-components";
import { DirectoryError, resolveDirectory } from "../auth/directory";
import { actions } from "../store/store";

const useStyles = makeStyles({
  choices: { display: "flex", flexDirection: "column", alignItems: "center", rowGap: tokens.spacingVerticalM, maxWidth: "460px", width: "100%" },
  directory: { display: "flex", flexDirection: "column", rowGap: tokens.spacingVerticalS, width: "100%", textAlign: "left" },
  row: { display: "flex", columnGap: tokens.spacingHorizontalS, alignItems: "flex-start" },
  grow: { flex: 1 },
  muted: { color: tokens.colorNeutralForeground2 },
});

const SIGN_IN_FAILED = "Signing in did not work. Try again.";

/**
 * How a user signs in. Any work or school account goes through one button. A personal Microsoft account has no Azure
 * of its own: it reaches Azure through a directory it belongs to, so the user names that directory by a subscription
 * ID, a domain or its ID, and the sign-in goes to it.
 */
export function SignInChoices({ openDirectory, loginHint }: { readonly openDirectory: boolean; readonly loginHint: string | null }): JSX.Element {
  const styles = useStyles();
  const [open, setOpen] = useState(openDirectory);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setProblem(null);
    setBusy(true);
    try {
      const directory = await resolveDirectory(text);
      await actions.signIn({ directory, ...(loginHint ? { loginHint } : {}) });
    } catch (error) {
      setBusy(false);
      setProblem(error instanceof DirectoryError ? error.message : SIGN_IN_FAILED);
    }
  };

  return (
    <div className={styles.choices} data-testid="sign-in-choices">
      <Button appearance="primary" size="large" onClick={() => void actions.signIn()} data-testid="sign-in">
        Sign in with Microsoft
      </Button>
      <Button appearance="transparent" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="directory-toggle">
        Personal account or a specific directory
      </Button>
      {open ? (
        <form className={styles.directory} onSubmit={(event) => void submit(event)} data-testid="directory-form">
          <Text size={200} className={styles.muted}>
            A personal Microsoft account reaches Azure through a directory it belongs to, such as the default directory of your Azure
            subscription. Enter one of your subscription IDs, or the domain or ID of the directory.
          </Text>
          <Field label="Subscription ID, directory domain or directory ID" validationState={problem ? "error" : "none"} validationMessage={problem}>
            <div className={styles.row}>
              <Input className={styles.grow} value={text} onChange={(_, data) => setText(data.value)} autoComplete="off" spellCheck={false} data-testid="directory-input" />
              <Button type="submit" appearance="primary" disabled={busy || text.trim() === ""} data-testid="directory-continue">
                Continue
              </Button>
            </div>
          </Field>
        </form>
      ) : null}
    </div>
  );
}
