"use client";

/**
 * One question, and the answers it came with.
 *
 * Buttons rather than a dropdown and a submit: there are two to four answers and the whole
 * interaction is one click. §7 asks for questions "answerable without technical knowledge",
 * and the shortest path from reading the question to being done with it is the answer
 * itself being the thing you press.
 *
 * A question whose stored options did not survive still gets a text box. Better than a row
 * the user can read and cannot answer.
 */

import { useActionState } from "react";

import { answerQuestionAction, type AnswerFormState } from "../actions";
import styles from "./page.module.css";

export function AnswerForm({ questionId, options }: { questionId: string; options: string[] }) {
  const [state, action, pending] = useActionState<AnswerFormState, FormData>(
    answerQuestionAction,
    {},
  );

  return (
    <form className={styles.answers} action={action}>
      <input type="hidden" name="questionId" value={questionId} />

      {options.length > 0 ? (
        options.map((option) => (
          <button
            className={styles.option}
            key={option}
            type="submit"
            name="answer"
            value={option}
            disabled={pending}
          >
            {option}
          </button>
        ))
      ) : (
        <>
          <input
            className={styles.input}
            name="answer"
            type="text"
            placeholder="Tell us what this payment was"
            aria-label="Your answer"
          />
          <button className={styles.option} type="submit" disabled={pending}>
            Save
          </button>
        </>
      )}

      {state.error ? <p className={styles.error}>{state.error}</p> : null}
    </form>
  );
}
