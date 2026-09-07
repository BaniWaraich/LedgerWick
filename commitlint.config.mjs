export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // AGENTS.md #8: the message explains what changed, not which files were touched.
    "body-max-line-length": [1, "always", 100],
  },
};
