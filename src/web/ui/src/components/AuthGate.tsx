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
import { actions, useStore } from "../store/store";

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
  brand: { display: "flex", alignItems: "center", columnGap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
});

/**
 * Renders nothing of the app until the sign-in is settled: the app reads its config, then either signs the user in or,
 * when it runs as the developer's own identity, goes straight on. Until then the page says it is signing in, and when
 * that fails it says why and offers to try again.
 */
export function AuthGate({ children }: { readonly children: ReactNode }): JSX.Element {
  const styles = useStyles();
  const status = useStore((state) => state.authStatus);
  const mode = useStore((state) => state.authMode);
  const error = useStore((state) => state.authError);
  const theme = useStore((state) => state.theme);

  useEffect(() => {
    void actions.startAuth();
  }, []);

  if (status === "ready") return <>{children}</>;

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
                <MessageBarTitle>{mode === null ? "The sign-in settings could not be loaded" : "Sign-in failed"}</MessageBarTitle>
                <span data-testid="auth-failed-message">{error}</span>
              </MessageBarBody>
            </MessageBar>
            <Button appearance="primary" onClick={() => void actions.startAuth()} data-testid="auth-retry">
              {mode === null ? "Try again" : "Sign in again"}
            </Button>
          </>
        ) : (
          <Spinner label={mode === "entra" ? "Signing in" : "Loading"} labelPosition="below" data-testid="auth-starting" />
        )}
      </main>
    </FluentProvider>
  );
}
