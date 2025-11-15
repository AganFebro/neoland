package nftdeploy

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/carv-protocol/d.a.t.a/src/pkg/llm"
)

// Params holds the extracted NFT deployment fields.
type Params struct {
	Name      string
	Symbol    string
	MintPrice float64
	Supply    int
}

// MintParams holds parsed fields for a mint request
// initiated via Discord (not a deploy).
type MintParams struct {
	CollectionID string
	Quantity     int
	Currency     string // "SOL" or "CARV".
}

// TryExtractParamsFast tries to parse fields using simple patterns first.
func TryExtractParamsFast(text string) (Params, bool) {
	src := normalizeQuotes(text)
	lower := strings.ToLower(src)
	// Quick intent check.
	if !(strings.Contains(lower, "deploy") || strings.Contains(lower, "launch")) ||
		!strings.Contains(lower, "nft") {
		return Params{}, false
	}

	// Regex helpers (case-insensitive).
	reName := regexp.MustCompile(`(?i)name\s*[:=]\s*(?:"([^"]+)"|'([^']+)')`)
	reSymbol := regexp.MustCompile(`(?i)symbol\s*[:=]\s*([A-Za-z0-9_-]{1,16})`)
	// e.g. 0.02 or 0.
	reMintPrice := regexp.MustCompile(`(?i)(?:mint\s*price|mint)\s*[:=]\s*([0-9]*\.?[0-9]+)`)
	reSupply := regexp.MustCompile(`(?i)supply\s*[:=]\s*(\d+)`)

	var p Params
	priceSet := false
	if m := reName.FindStringSubmatch(src); len(m) >= 2 {
		if m[1] != "" {
			p.Name = strings.TrimSpace(m[1])
		} else if len(m) >= 3 {
			p.Name = strings.TrimSpace(m[2])
		}
	}
	if m := reSymbol.FindStringSubmatch(src); len(m) >= 2 {
		p.Symbol = strings.ToUpper(strings.TrimSpace(m[1]))
	}
	if m := reMintPrice.FindStringSubmatch(src); len(m) >= 2 {
		if f, err := strconv.ParseFloat(m[1], 64); err == nil {
			p.MintPrice = f
			priceSet = true
		}
	}
	if m := reSupply.FindStringSubmatch(src); len(m) >= 2 {
		if n, err := strconv.Atoi(m[1]); err == nil {
			p.Supply = n
		}
	}

	ok := p.Name != "" && p.Symbol != "" && priceSet && p.MintPrice >= 0 && p.Supply > 0
	return p, ok
}

// TryExtractMintParamsFast tries to detect a mint intent and extract
// collection id, quantity, and currency using simple patterns.
// It is intentionally conservative to avoid mis-classifying deploy requests.
func TryExtractMintParamsFast(text string) (MintParams, bool) {
	src := normalizeQuotes(text)
	lower := strings.ToLower(src)
	// Quick intent check: must mention "mint".
	if !strings.Contains(lower, "mint") {
		return MintParams{}, false
	}
	// If the user explicitly says "deploy" or "launch", treat as deploy, not mint.
	if strings.Contains(lower, "deploy") || strings.Contains(lower, "launch") {
		return MintParams{}, false
	}

	// Prefer explicit "collection id" / "id" pattern first.
	reCollID := regexp.MustCompile(
		`(?i)collection\s*id\s*[:=]?\s*([A-Za-z0-9_-]+)`,
	)
	reLooseID := regexp.MustCompile(
		`(?i)\bid\s*(?:is|:|=)?\s*([A-Za-z0-9_-]{3,})`,
	)
	var p MintParams
	if m := reCollID.FindStringSubmatch(src); len(m) >= 2 {
		candidate := strings.TrimSpace(m[1])
		if isLikelyCollectionID(candidate) {
			p.CollectionID = candidate
		}
	}
	if p.CollectionID == "" {
		if m := reLooseID.FindStringSubmatch(src); len(m) >= 2 {
			candidate := strings.TrimSpace(m[1])
			if isLikelyCollectionID(candidate) {
				p.CollectionID = candidate
			}
		}
	}

	// If not found, accept "collection <id>" (e.g., "this collection w1wbbuqp").
	if p.CollectionID == "" {
		reColl := regexp.MustCompile(
			`(?i)collection\s+([A-Za-z0-9][A-Za-z0-9_-]{3,})`,
		)
		if m := reColl.FindStringSubmatch(src); len(m) >= 2 {
			candidate := strings.TrimSpace(m[1])
			if isLikelyCollectionID(candidate) {
				p.CollectionID = candidate
			}
		}
	}

	// As a next step, look for an id-like token immediately after "mint" / "mint this".
	if p.CollectionID == "" {
		reMintID := regexp.MustCompile(
			`(?i)mint(?:\s+this|\s+collection|\s+from|\s+id|\s+the)?\s+([A-Za-z0-9][A-Za-z0-9_-]{3,})`,
		)
		if m := reMintID.FindStringSubmatch(src); len(m) >= 2 {
			candidate := strings.TrimSpace(m[1])
			if isLikelyCollectionID(candidate) {
				p.CollectionID = candidate
			}
		}
	}

	// Final fallback: take the last id-like token in the message that looks
	// like a collection id (e.g., "mint this NFT 6z6dfl69").
	if p.CollectionID == "" {
		tokens := strings.FieldsFunc(src, func(r rune) bool {
			switch r {
			case ' ', '\t', '\n', '\r', ',', '.', '!', '?':
				return true
			default:
				return false
			}
		})
		ignore := map[string]struct{}{
			"nft":        {},
			"sol":        {},
			"carv":       {},
			"collection": {},
			"id":         {},
		}
		for i := len(tokens) - 1; i >= 0; i-- {
			t := strings.Trim(tokens[i], "\"'`")
			if len(t) < 4 {
				continue
			}
			lowerTok := strings.ToLower(t)
			if _, skip := ignore[lowerTok]; skip {
				continue
			}
			if isLikelyCollectionID(t) {
				p.CollectionID = t
				break
			}
		}
	}

	// Quantity: look for explicit small counts near "mint" or "NFT".
	// Examples:
	//   "mint 3", "mint 2 nfts", "3 nfts", "1 amount".
	// We intentionally ignore digits inside ids or huge numbers
	// (e.g., Discord user ids in mentions).
	reMintQty := regexp.MustCompile(`(?i)mint\s+(\d{1,3})\b`)
	if m := reMintQty.FindStringSubmatch(src); len(m) >= 2 {
		if n, err := strconv.Atoi(m[1]); err == nil && n > 0 && n <= 1000 {
			p.Quantity = n
		}
	}
	if p.Quantity <= 0 {
		reNftQty := regexp.MustCompile(`(?i)\b(\d{1,3})\s+(?:nft|nfts|amount)\b`)
		if m := reNftQty.FindStringSubmatch(src); len(m) >= 2 {
			if n, err := strconv.Atoi(m[1]); err == nil && n > 0 && n <= 1000 {
				p.Quantity = n
			}
		}
	}
	if p.Quantity <= 0 {
		p.Quantity = 1
	}

	if strings.Contains(lower, "carv") {
		p.Currency = "CARV"
	} else {
		p.Currency = "SOL"
	}

	// Only treat as mint if we have a plausible collection id.
	ok := isLikelyCollectionID(p.CollectionID)
	if !ok {
		p.CollectionID = ""
	}
	return p, ok
}

func isLikelyCollectionID(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) < 4 || len(s) > 32 {
		return false
	}
	if strings.ContainsAny(s, " \t\r\n") {
		return false
	}
	if strings.IndexAny(s, "0123456789") < 0 {
		return false
	}
	lower := strings.ToLower(s)
	if lower == "nft" || lower == "collection" || lower == "id" {
		return false
	}
	for _, r := range s {
		if (r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') ||
			r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func extractQuoted(text, prefix string) string {
	s := normalizeQuotes(text)
	// Accept both double and single quotes.
	re := regexp.MustCompile(prefix + `(?:"([^"]+)"|'([^']+)')`)
	if m := re.FindStringSubmatch(s); len(m) >= 2 {
		if m[1] != "" {
			return m[1]
		}
		if len(m) >= 3 {
			return m[2]
		}
	}
	return ""
}

func normalizeQuotes(s string) string {
	// Replace curly quotes with straight quotes.
	replacer := strings.NewReplacer(
		"“", "\"", "”", "\"",
		"‘", "'", "’", "'",
	)
	return replacer.Replace(s)
}

// ExtractParamsLLM uses the LLM to coerce text -> structured params as JSON.
func ExtractParamsLLM(
	ctx context.Context,
	llmClient llm.Client,
	model,
	text string,
) (Params, bool, error) {
	prompt := `You are a precise parser. Read the user text and extract NFT deployment parameters strictly as JSON with keys: name (string), symbol (string), mint_price (number), supply (integer). If the text does not clearly request deploying an NFT and does not include enough info, respond with {"intent":"no"}. Otherwise respond with {"intent":"yes","name":"...","symbol":"...","mint_price":0.0,"supply":0}.

Return ONLY JSON.`

	out, err := llmClient.CreateCompletion(
		ctx,
		llm.CompletionRequest{
			Model: model,
			Messages: []llm.Message{
				{Role: "system", Content: prompt},
				{Role: "user", Content: text},
			},
		},
	)
	if err != nil {
		return Params{}, false, err
	}

	// Massage common fenced formatting.
	s := strings.TrimSpace(out)
	if strings.HasPrefix(s, "```json") {
		s = strings.TrimSuffix(strings.TrimPrefix(s, "```json"), "```")
	}
	if strings.HasPrefix(s, "```") {
		s = strings.TrimSuffix(strings.TrimPrefix(s, "```"), "```")
	}

	type resp struct {
		Intent string  `json:"intent"`
		Name   string  `json:"name"`
		Symbol string  `json:"symbol"`
		Mint   float64 `json:"mint_price"`
		Supply int     `json:"supply"`
	}

	var r resp
	if err := jsonUnmarshalSafe(s, &r); err != nil {
		return Params{}, false, err
	}
	if strings.ToLower(r.Intent) != "yes" {
		return Params{}, false, nil
	}
	p := Params{
		Name:      r.Name,
		Symbol:    strings.ToUpper(r.Symbol),
		MintPrice: r.Mint,
		Supply:    r.Supply,
	}
	ok := p.Name != "" && p.Symbol != "" && p.MintPrice >= 0 && p.Supply > 0
	return p, ok, nil
}

// ExtractMintParamsLLM uses the LLM to coerce text -> structured mint params.
func ExtractMintParamsLLM(
	ctx context.Context,
	llmClient llm.Client,
	model,
	text string,
) (MintParams, bool, error) {
	prompt := `You are a precise parser. Read the Discord message and decide if the user is asking to mint NFTs from an existing collection.

If they are NOT asking to mint, respond with:
{"intent":"no"}

If they ARE asking to mint from a collection, respond with:
{"intent":"yes","collection_id":"...","quantity":1,"currency":"SOL"}

Rules:
- collection_id is the short collection identifier (e.g. "6z6dfl69"). If none is present, use "".
- quantity is how many NFTs to mint. If unclear, default to 1.
- currency is "CARV" if they clearly ask to use CARV tokens, otherwise "SOL".

Return ONLY JSON.`

	out, err := llmClient.CreateCompletion(
		ctx,
		llm.CompletionRequest{
			Model: model,
			Messages: []llm.Message{
				{Role: "system", Content: prompt},
				{Role: "user", Content: text},
			},
		},
	)
	if err != nil {
		return MintParams{}, false, err
	}

	s := strings.TrimSpace(out)
	if strings.HasPrefix(s, "```json") {
		s = strings.TrimSuffix(strings.TrimPrefix(s, "```json"), "```")
	}
	if strings.HasPrefix(s, "```") {
		s = strings.TrimSuffix(strings.TrimPrefix(s, "```"), "```")
	}

	type resp struct {
		Intent       string `json:"intent"`
		CollectionID string `json:"collection_id"`
		Quantity     int    `json:"quantity"`
		Currency     string `json:"currency"`
	}

	var r resp
	if err := jsonUnmarshalSafe(s, &r); err != nil {
		return MintParams{}, false, err
	}
	if strings.ToLower(r.Intent) != "yes" {
		return MintParams{}, false, nil
	}

	mp := MintParams{
		CollectionID: strings.TrimSpace(r.CollectionID),
		Quantity:     r.Quantity,
		Currency:     strings.ToUpper(strings.TrimSpace(r.Currency)),
	}
	if mp.Quantity <= 0 {
		mp.Quantity = 1
	}
	if mp.Currency != "CARV" {
		mp.Currency = "SOL"
	}

	ok := mp.CollectionID != ""
	return mp, ok, nil
}

// Minimal wrapper to avoid importing encoding/json here in case we change later.
func jsonUnmarshalSafe(s string, v any) error {
	type u interface {
		Unmarshal([]byte, any) error
	}
	return stdUnmarshal([]byte(s), v)
}

var stdUnmarshal = func(b []byte, v any) error {
	return json.Unmarshal(b, v)
}
