import { useEffect } from "react";
import type { JSX, ReactNode } from "react";
import {
  Button,
  FluentProvider,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Text,
  makeStyles,
  tokens,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import { HeartPulse24Regular } from "@fluentui/react-icons";
import { needsDirectory, signInHint } from "../model/errors";
import { actions, useStore } from "../store/store";
import { SignInChoices } from "./SignInChoices";

const useStyles = makeStyles({
  page: {
    minHeight: ["100vh", "100dvh"],
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    rowGap: tokens.spacingVerticalL,
    padding: tokens.spacingHorizontalXL,
    boxSizing: "border-box",
    textAlign: "center",
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  failure: { maxWidth: "520px", textAlign: "left" },
  lead: { color: tokens.colorNeutralForeground2 },
  technical: { display: "block", marginTop: tokens.spacingVerticalXS, fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, overflowWrap: "anywhere" },
  brand: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
});

/**
 * Renders nothing of the app until the sign-in is settled: the app reads its config, then either goes straight on, as
 * the developer's own identity or for a user who is signed in, or asks the user to sign in. When a sign-in fails the page
 * says why and offers the same ways to sign in again.
 */
export function AuthGate({ children }: { readonly children: ReactNode }): JSX.Element {
  const styles = useStyles();
  const status = useStore((state) => state.authStatus);
  const mode = useStore((state) => state.authMode);
  const error = useStore((state) => state.authError);
  const personal = useStore((state) => state.personalAccount);
  const theme = useStore((state) => state.theme);
  const hint = signInHint(error);

  useEffect(() => {
    void actions.startAuth();
  }, []);

  if (status === "ready") return <>{children}</>;

  const choosing = mode === "entra" && (status === "signed-out" || status === "personal" || status === "failed");

  return (
    <FluentProvider theme={theme === "dark" ? webDarkTheme : webLightTheme} data-testid="auth-gate">
      <main className={styles.page} data-status={status}>
        <div className={styles.brand}>
          <HeartPulse24Regular aria-hidden="true" />
          <Text size={500} weight="bold">
            Health Pulse
          </Text>
        </div>
        {status === "failed" ? (
          <>
            <MessageBar intent="error" role="alert" className={styles.failure} data-testid="auth-failed">
              <MessageBarBody>
                <MessageBarTitle>{mode === null ? "The app could not start signing you in" : "We could not sign you in"}</MessageBarTitle>
                {hint !== null ? <span data-testid="auth-failed-hint">{hint} </span> : null}
                <span className={styles.technical} data-testid="auth-failed-message">{error}</span>
              </MessageBarBody>
            </MessageBar>
            {choosing ? (
              <SignInChoices openDirectory={needsDirectory(error)} loginHint={null} />
            ) : (
              <Button appearance="primary" onClick={() => void actions.startAuth()} data-testid="auth-retry">
                Try again
              </Button>
            )}
          </>
        ) : choosing ? (
          <>
            {status === "personal" ? (
              <MessageBar intent="warning" className={styles.failure} data-testid="auth-personal">
                <MessageBarBody>
                  <MessageBarTitle>{personal === null ? "That is a personal account" : `${personal} is a personal account`}</MessageBarTitle>
                  A personal Microsoft account has no Azure of its own. It reaches Azure through a directory where it is a member or a guest, so
                  name that directory below.
                </MessageBarBody>
              </MessageBar>
            ) : (
              <Text className={styles.lead}>Sign in with the account you use for Azure.</Text>
            )}
            <SignInChoices openDirectory={status === "personal"} loginHint={personal} />
          </>
        ) : (
          <Spinner label={mode === "entra" ? "Signing in" : "Loading"} labelPosition="below" data-testid="auth-starting" />
        )}
      </main>
    </FluentProvider>
  );
}
