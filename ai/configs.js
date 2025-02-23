"use strict";

// Notes on non-obvious fields:
//
//	max_tokens_key		-- The key used in the data object when specifying the max tokens value; OpenAI deprecated "max_tokens"
//	sp_role				-- The role for IN-ARRAY system prompt messages, typically "system" but maybe "developer" or "user"
//	temperature			-- Likely 0-1, but use -1 if we shouldn't send this field
//
// Note on OpenRouter reasoning models:
// For OpenRouter, we have to set "include_reasoning" if we want to get sent the reasoning (if any).
// In that case, it comes back in a separate part of the response JSON.
//
// Ultimately the client's copy of the config will get every field.
// Some can use "" or -1 to be unused.

exports.Required = ["model", "name", "company", "url"];

exports.Defaults = {

	max_tokens_key: "max_tokens",
	sp_role: "system",

	version: "",					// Like "name", this is mostly for system prompts, etc (not needed for comms).

	max_tokens: 8192,
	system_prompt: "",				// Not sent if ""
	temperature: -1,				// Not sent if -1
	reasoning_effort: "",			// Not sent if ""			(OpenAI API)
	anthropic_version: "",			// Not sent if ""

	show_reasoning: false,			// Internal flag for OpenRouter requests - we should always receive the reasoning, but do we display it?
	max_errors: 10,
	min_delay: 1,
	max_delay: 16,
};
