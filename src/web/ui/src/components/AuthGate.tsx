import { useEffect, useLayoutEffect } from "react";
import type { JSX, ReactNode } from "react";
import {
  Button, FluentProvider, MessageBar, MessageBarBody, MessageBarTitle, Spinner, Text,
  makeStyles, tokens, webDarkTheme, webLightTheme,
} from "@fluentui/react-components";
import { HeartPulse24Regular } from "@fluentui/react-icons";
import { workspaceLink } from "../auth/workspaceLink";
import { signInHint } from "../model/errors";
import { actions, useStore } from "../store/store";
import { DirectoryChooser } from "./DirectoryChooser";

const useStyles = makeStyles({
  page: {
    minHeight: ["100vh", "100dvh"], boxSizing: "border-box", display: "grid", placeItems: "center",
    padding: tokens.spacingHorizontalL, backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground1,
  },
  panel: {
    display: "grid", gap: tokens.spacingVerticalXL, width: "100%", maxWidth: "540px", boxSizing: "border-box",
    padding: "clamp(20px,5vw,40px)", border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  login: { justifySelf: "start" },
  technical: { display: "block", marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, overflowWrap: "anywhere" },
  brand: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
});

/** The workspace mounts only after the user has selected a directory or the local server supplies the identity. */
export function AuthGate({ children }: { readonly children: ReactNode }): JSX.Element {
  const styles = useStyles();
  const status = useStore((state) => state.authStatus);
  const mode = useStore((state) => state.authMode);
  const error = useStore((state) => state.authError);
  const theme = useStore((state) => state.theme);
  const hint = signInHint(error);

  useEffect(() => {
    void actions.startAuth();
  }, []);

  const account = useStore(state => state.account);
  const linkTenant = new URLSearchParams(window.location.search).get("tenant");
  const wrongTenant = Boolean(account && linkTenant && linkTenant.toLowerCase() !== account.tenantId.toLowerCase());

  useLayoutEffect(() => {
    if (status === "ready" && account && !linkTenant) {
      const { pathname, search, hash } = window.location;
      window.history.replaceState(window.history.state, "", workspaceLink(pathname + search + hash));
    }
  }, [status, account, linkTenant]);

  if (status === "ready" && !wrongTenant) return <>{children}</>;

  return (
    <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme} data-testid="auth-gate">
      <main className={styles.page} data-status={status}>
        <section className={styles.panel} aria-label="Health Pulse sign-in">
          <div className={styles.brand}>
            <HeartPulse24Regular aria-hidden="true" />
            <Text size={500} weight="bold">Health Pulse</Text>
          </div>
          {status === "ready" && account ? (
            <div data-testid="tenant-mismatch">
              <Text as="h1" size={600} weight="semibold">This link opens another directory</Text>
              <p>Your workspace is open in <strong>{account.tenantName || account.tenantId}</strong>.
                To open this link, sign out and choose directory <strong>{linkTenant}</strong>.</p>
              <Button appearance="primary" onClick={() => void actions.signOut()}>Sign out</Button>
              <Button as="a" appearance="subtle" href={workspaceLink("/")}>Open my current workspace</Button>
            </div>
          ) : status === "choose-directory" ? <DirectoryChooser /> : (status === "starting" || status === "signing-out") ? (
            <Spinner label={status === "signing-out" ? "Signing out" : mode === "entra" ? "Signing in" : "Loading"} data-testid="auth-starting" />
          ) : <>
            {(status === "failed" || (status === "signed-out" && error)) ? (
              <MessageBar intent="error" role="alert" data-testid="auth-failed">
                <MessageBarBody>
                  <MessageBarTitle>{status === "signed-out" ? "Microsoft could not finish signing you out" : mode === null ? "The app could not start signing you in" : "We could not sign you in"}</MessageBarTitle>
                  {hint && <span data-testid="auth-failed-hint">{hint}</span>}
                  <span className={styles.technical} data-testid="auth-failed-message">{error}</span>
                </MessageBarBody>
              </MessageBar>
            ) : <div>
              <Text as="h1" size={700} weight="semibold">Open your health models</Text>
              <p>Sign in with the Microsoft account you use for Azure. You’ll choose your directory next.</p>
            </div>}
            {mode === "entra" && !linkTenant && (
              <details>
                <summary>Accessing a directory as a guest?</summary>
                <p>On the Microsoft sign-in page, choose <strong>Sign-in options</strong>, then
                  <strong> Sign in to an organization</strong> and enter its domain.</p>
              </details>
            )}
            {mode === "entra" ? (
              <Button className={styles.login} appearance="primary" size="large" onClick={() => void actions.signIn()} data-testid="sign-in">
                Sign in with Microsoft
              </Button>
            ) : (
              <Button className={styles.login} appearance="primary" onClick={() => void actions.startAuth()} data-testid="auth-retry">Try again</Button>
            )}
            {mode === "entra" && status === "failed" && (
              <Button className={styles.login} appearance="subtle" onClick={() => void actions.signOut()}>Sign out</Button>
            )}
          </>}
        </section>
      </main>
    </FluentProvider>
  );
}
