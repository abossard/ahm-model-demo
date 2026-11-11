import type { JSX } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import { inlineParts, splitAnswer } from "../model/agentText";

const useStyles = makeStyles({
  // Identifiers are for whoever needs them; they sit in the text without pulling the eye.
  code: {
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: "0.92em",
    color: tokens.colorNeutralForeground3,
    overflowWrap: "anywhere",
  },
  answer: { fontWeight: tokens.fontWeightSemibold },
  evidence: { color: tokens.colorNeutralForeground2 },
});

/** Text the assistant wrote, with inline code, resource paths and ids shown quietly. */
export function AgentText({ text }: { readonly text: string }): JSX.Element {
  const styles = useStyles();
  return (
    <>
      {inlineParts(text).map((part, index) =>
        part.code ? (
          <code key={index} className={styles.code}>
            {part.text}
          </code>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** A summary or finding: the first sentence stands out as the answer, the rest reads as the evidence for it. */
export function AnswerText({ text }: { readonly text: string }): JSX.Element {
  const styles = useStyles();
  const { answer, evidence } = splitAnswer(text);
  return (
    <>
      <span className={styles.answer}>
        <AgentText text={answer} />
      </span>
      {evidence !== "" ? (
        <>
          {" "}
          <span className={styles.evidence}>
            <AgentText text={evidence} />
          </span>
        </>
      ) : null}
    </>
  );
}
