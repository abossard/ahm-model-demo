import type { JSX } from "react";
import { Button, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, Text, makeStyles, tokens } from "@fluentui/react-components";
import { Building20Regular, SignOut20Regular } from "@fluentui/react-icons";
import { actions, useStore } from "../store/store";

const useStyles = makeStyles({
  labels: { display: "grid", minWidth: 0, textAlign: "left" },
  name: {
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "150px",
    "@media (max-width: 720px)": { maxWidth: "110px" },
  },
  person: { color: tokens.colorNeutralForeground2, fontSize: tokens.fontSizeBase100, "@media (max-width: 720px)": { display: "none" } },
  account: { display: "grid", gap: "2px", padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, maxWidth: "320px", overflowWrap: "anywhere" },
  muted: { color: tokens.colorNeutralForeground2 },
});

/** The selected directory stays visible throughout the workspace. Signing out releases the selection. */
export function UserMenu(): JSX.Element | null {
  const styles = useStyles();
  const account = useStore((state) => state.account);
  if (account === null) return null;
  const directory = account.tenantName || account.tenantId;
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button size="small" appearance="subtle" icon={<Building20Regular />}
          aria-label={`Account of ${account.name} in ${directory}`} title={directory} data-testid="user-menu">
          <span className={styles.labels}>
            <span className={styles.name} data-testid="user-directory">{directory}</span>
            <span className={styles.person} data-testid="user-name">{account.name}</span>
          </span>
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <div className={styles.account} data-testid="user-account">
          <Text weight="semibold">{account.name}</Text>
          <Text size={200} className={styles.muted}>{account.username}</Text>
          <Text weight="semibold">{directory}</Text>
          <Text size={200} className={styles.muted}>Tenant {account.tenantId}</Text>
          <Text size={200} className={styles.muted}>Sign out to choose another directory.</Text>
        </div>
        <MenuDivider />
        <MenuList>
          <MenuItem icon={<SignOut20Regular />} onClick={() => void actions.signOut()} data-testid="sign-out">Sign out</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
