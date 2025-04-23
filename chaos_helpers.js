"use strict";

// ------------------------------------------------------------------------------------------------
// Fetcher - to avoid multiple fetches by the bots... written by Claude, mostly...
// This is maybe the 3rd, simplest version of this.

let fetcher_promises = Object.create(null);			// Holds only promises.

// Remember multiple callers may get the same promise, which will resolve to the same response
// unless we do something about it. What we need to do is ensure each return out of this function
// (thankfully there's just one return now) adds a .then() which clones it.

exports.fetcher = function(url, options = {}) {		// Must always return a promise.

	if (typeof url !== "string") {
		return Promise.reject(new Error("fetcher: expected string"));
	}

	if (!Object.hasOwn(fetcher_promises, url)) {

		fetcher_promises[url] = fetch(url, options).then(response => {

			if (!response.ok) {
				delete fetcher_promises[url];
				throw new Error(`HTTP error! status: ${response.status}`);
			}

			setTimeout(() => {
				delete fetcher_promises[url];
			}, 300000);								// Remove from cache after 5 minutes

			return response;
		});
	}

	return fetcher_promises[url].then(response => response.clone());
};

// ------------------------------------------------------------------------------------------------

exports.split_text_into_chunks = function(text, maxlen) {			// Written by Claude.

	// Reduce effective maxlen by 30 characters to create buffer space for code block handling
	let true_maxlen = maxlen;
	maxlen -= 30;

	text = text.replace(/\n(?:\s*\n)+/g, "\n\n");
	text = text.trim();

	// If empty, return empty
	if (text.length === 0) {
		return [];
	}

	// If text is short enough, just return it
	if (text.length <= true_maxlen) {
		return [text];
	}

	let chunks = [];

	// Try to split at paragraph boundaries first
	let paragraphs = text.split("\n\n");
	let current_chunk = "";

	for (let i = 0; i < paragraphs.length; i++) {
		let paragraph = paragraphs[i];

		// If a single paragraph is longer than maxlen, we'll need to split it
		if (paragraph.length > maxlen) {
			// First send the current chunk if it exists
			if (current_chunk) {
				chunks.push(current_chunk);
				current_chunk = "";
			}

			// Split long paragraph by sentences or just characters if needed
			let paragraphChunks = exports.split_paragraph(paragraph, maxlen);
			chunks = chunks.concat(paragraphChunks);
		}
		// If adding this paragraph would exceed maxlen, push current chunk and start a new one
		else if (current_chunk.length + paragraph.length + 2 > maxlen) {
			chunks.push(current_chunk);
			current_chunk = paragraph;
		}
		// Otherwise add the paragraph to the current chunk
		else {
			if (current_chunk) {
				current_chunk += "\n\n" + paragraph;
			} else {
				current_chunk = paragraph;
			}
		}
	}

	// Don't forget the last chunk
	if (current_chunk) {
		chunks.push(current_chunk);
	}

	chunks = chunks.map(s => s.trim()).filter(s => s !== "");

	// Process code blocks that might be split across chunks, passing the true maxlen
	return fix_code_blocks(chunks, true_maxlen);
};

exports.split_paragraph = function(paragraph, maxlen) {			// Written by Claude.

	// If paragraph is short enough, just return it
	if (paragraph.length <= maxlen) {
		return [paragraph];
	}

	let chunks = [];

	// Try to split by sentences first
	let sentences = paragraph.split(/(?<=[.!?])\s+/);
	let current_chunk = "";

	for (let sentence of sentences) {
		// If single sentence is too long, we'll need to split it by characters
		if (sentence.length > maxlen) {
			// Send current chunk if it exists
			if (current_chunk) {
				chunks.push(current_chunk);
				current_chunk = "";
			}

			// Split by characters with some buffer for code blocks
			for (let i = 0; i < sentence.length; i += maxlen) {
				chunks.push(sentence.substring(i, i + maxlen));
			}
		}
		// If adding this sentence would exceed maxlen, start a new chunk
		else if (current_chunk.length + sentence.length + 1 > maxlen) {
			chunks.push(current_chunk);
			current_chunk = sentence;
		}
		// Otherwise add the sentence to current chunk
		else {
			if (current_chunk) {
				current_chunk += " " + sentence;
			} else {
				current_chunk = sentence;
			}
		}
	}

	// Don't forget the last chunk
	if (current_chunk) {
		chunks.push(current_chunk);
	}

	return chunks;
};

function fix_code_blocks(chunks, true_maxlen) {					// Written by Claude.

	if (chunks.length <= 1) {
		return chunks;
	}

	let result = [];
	let openCodeBlock = null;

	for (let i = 0; i < chunks.length; i++) {
		let chunk = chunks[i];

		// Check if this chunk ends with an unclosed code block
		let codeBlockMatches = chunk.match(/^```(\w*)[^`]*$/m);
		let endsWithUnclosedCodeBlock = codeBlockMatches && !chunk.endsWith("```");

		if (endsWithUnclosedCodeBlock) {
			// Store the language if specified
			openCodeBlock = codeBlockMatches[1] || "";

			// Close the code block at the end of this chunk
			let modified_chunk = chunk + "\n```";

			// Check if it's still within maxlen
			if (modified_chunk.length <= true_maxlen) {
				result.push(modified_chunk);
			} else {
				// Fallback to using the original chunk in this case
				result.push(chunk);
			}
		} else if (openCodeBlock !== null && i > 0) {
			// This chunk continues a code block from the previous chunk
			// Prepend a code block marker with the same language
			let languageSpec = openCodeBlock ? openCodeBlock : "";
			let modified_chunk = "```" + languageSpec + "\n" + chunk;

			// Check if it's within maxlen
			if (modified_chunk.length <= true_maxlen) {
				result.push(modified_chunk);
			} else {
				// Fallback to simpler opening (no language spec) if too long
				modified_chunk = "```\n" + chunk;
				if (modified_chunk.length <= true_maxlen) {
					result.push(modified_chunk);
				} else {
					result.push(chunk);
				}
			}

			// Reset openCodeBlock if this chunk ends with ```
			if (chunk.endsWith("```")) {
				openCodeBlock = null;
			}
		} else {
			result.push(chunk);

			// Check if this chunk opened and closed code blocks
			let closedBlocks = (chunk.match(/```/g) || []).length;
			if (closedBlocks % 2 !== 0) {
				// Odd number of ``` markers means we have an unclosed block at the end
				let lastOpenPos = chunk.lastIndexOf("```");
				let language = "";

				// Extract language if specified
				let languageMatch = chunk.substring(lastOpenPos).match(/```(\w*)/);
				if (languageMatch) {
					language = languageMatch[1];
				}

				openCodeBlock = language;
			} else {
				openCodeBlock = null;
			}
		}
	}

	return result;
}

// ------------------------------------------------------------------------------------------------

exports.probably_text = function(content_type) {
	if (typeof content_type !== "string") {
		return false;
	}
	if (content_type.includes("charset=utf")) {
		return true;
	}
	for (let foo of ["text/", "application/json", "application/javascript", "application/x-python"]) {
		if (content_type.startsWith(foo)) {
			return true;
		}
	}
	return false;
};

exports.normalize_linebreaks = function(text) {
	text = text.replace(/\r\n/g, "\n");
	text = text.replace(/\r/g, "\n");
	return text;
};

exports.centre_string = function(s, width) {
	if (s.length >= width) {
		return s;
	}
	let total_padding = width - s.length;
	let left_padding = Math.floor(total_padding / 2);
	return " ".repeat(left_padding) + s;
};

exports.format_timestamp = function(date) {
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	const month = date.toLocaleString("en-GB", { month: "short" });
	const day = String(date.getDate()).padStart(2, "0");
	const year = date.getFullYear();
	return `${hours}:${minutes}:${seconds} on ${month} ${day}, ${year}`;
};

exports.date_from_snowflake = function(snowflake) {		// Unused but good to have.
	if (typeof snowflake === "string") {
		snowflake = BigInt(snowflake);
	}
	if (typeof snowflake !== "bigint") {
		throw new Error("date_from_snowflake: invalid argument");
	}
	let unixtime = BigInt(1420070400000) + (snowflake >> BigInt(22));
	return new Date(Number(unixtime));
};
