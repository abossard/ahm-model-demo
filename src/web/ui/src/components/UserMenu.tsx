import type { JSX } from "react";
import { Button, Menu, MenuDivider, MenuItem, MenuList, MenuPopover, MenuTrigger, Text, makeStyles, tokens } from "@fluentui/react-components";
import { Person20Regular, SignOut20Regular } from "@fluentui/react-icons";
import { actions, useStore } from "../store/store";

const useStyles = makeStyles({
  name: {
    maxWidth: "160px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    // On a phone the icon is enough: the account is one tap away in the menu.
    "@media (max-width: 720px)": { display: "none" },
  },
  account: { display: "flex", flexDirection: "column", rowGap: "2px", padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`, maxWidth: "320px", overflowWrap: "anywhere" },
  muted: { color: tokens.colorNeutralForeground2 },
});

/** Who is signed in, with their account, the tenant and the way to sign out. Nothing shows when nobody signs in. */
export function UserMenu(): JSX.Element | null {
  const styles = useStyles();
  const account = useStore((state) => state.account);
  if (account === null) return null;
  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <Button
          size="small"
          appearance="subtle"
          icon={<Person20Regular />}
          aria-label={`Account of ${account.name}`}
          data-testid="user-menu"
        >
          <span className={styles.name} data-testid="user-name">
            {account.name}
          </span>
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <div className={styles.account} data-testid="user-account">
          <Text weight="semibold">{account.name}</Text>
          <Text size={200} className={styles.muted}>
            {account.username}
          </Text>
          <Text size={200} className={styles.muted}>
            Tenant {account.tenantId}
          </Text>
        </div>
        <MenuDivider />
        <MenuList>
          <MenuItem icon={<SignOut20Regular />} onClick={() => void actions.signOut()} data-testid="sign-out">
            Sign out
          </MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
