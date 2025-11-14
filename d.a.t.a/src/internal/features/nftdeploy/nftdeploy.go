package nftdeploy

import (
    "context"
    "encoding/json"
    "regexp"
    "strconv"
    "strings"

    "github.com/carv-protocol/d.a.t.a/src/pkg/llm"
)

// Params holds the extracted NFT deployment fields
type Params struct {
    Name      string
    Symbol    string
    MintPrice float64
    Supply    int
}

// TryExtractParamsFast tries to parse fields using simple patterns first
func TryExtractParamsFast(text string) (Params, bool) {
    src := normalizeQuotes(text)
    lower := strings.ToLower(src)
    // Quick intent check
    if !(strings.Contains(lower, "deploy") || strings.Contains(lower, "launch")) || !strings.Contains(lower, "nft") {
        return Params{}, false
    }

    // Regex helpers (case-insensitive)
    reName := regexp.MustCompile(`(?i)name\s*[:=]\s*(?:"([^"]+)"|'([^']+)')`)
    reSymbol := regexp.MustCompile(`(?i)symbol\s*[:=]\s*([A-Za-z0-9_-]{1,16})`)
    reMintPrice := regexp.MustCompile(`(?i)(?:mint\s*price|mint)\s*[:=]\s*([0-9]*\.?[0-9]+)`) // e.g. 0.02 or 0
    reSupply := regexp.MustCompile(`(?i)supply\s*[:=]\s*(\d+)`)

    var p Params
    priceSet := false
    if m := reName.FindStringSubmatch(src); len(m) >= 2 {
        if m[1] != "" { p.Name = strings.TrimSpace(m[1]) } else if len(m) >= 3 { p.Name = strings.TrimSpace(m[2]) }
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
        if n, err := strconv.Atoi(m[1]); err == nil { p.Supply = n }
    }

    ok := p.Name != "" && p.Symbol != "" && priceSet && p.MintPrice >= 0 && p.Supply > 0
    return p, ok
}

func extractQuoted(text, prefix string) string {
    s := normalizeQuotes(text)
    // accept both double and single quotes
    re := regexp.MustCompile(prefix+`(?:"([^"]+)"|'([^']+)')`)
    if m := re.FindStringSubmatch(s); len(m) >= 2 {
        if m[1] != "" { return m[1] }
        if len(m) >= 3 { return m[2] }
    }
    return ""
}

func normalizeQuotes(s string) string {
    // Replace curly quotes with straight quotes
    replacer := strings.NewReplacer(
        "“", "\"", "”", "\"",
        "‘", "'", "’", "'",
    )
    return replacer.Replace(s)
}

// ExtractParamsLLM uses the LLM to coerce text -> structured params as JSON
func ExtractParamsLLM(ctx context.Context, llmClient llm.Client, model, text string) (Params, bool, error) {
    prompt := `You are a precise parser. Read the user text and extract NFT deployment parameters strictly as JSON with keys: name (string), symbol (string), mint_price (number), supply (integer). If the text does not clearly request deploying an NFT and does not include enough info, respond with {"intent":"no"}. Otherwise respond with {"intent":"yes","name":"...","symbol":"...","mint_price":0.0,"supply":0}.

Return ONLY JSON.`

    out, err := llmClient.CreateCompletion(ctx, llm.CompletionRequest{
        Model: model,
        Messages: []llm.Message{
            {Role: "system", Content: prompt},
            {Role: "user", Content: text},
        },
    })
    if err != nil { return Params{}, false, err }

    // Massage common fenced formatting
    s := strings.TrimSpace(out)
    if strings.HasPrefix(s, "```json") { s = strings.TrimSuffix(strings.TrimPrefix(s, "```json"), "```") }
    if strings.HasPrefix(s, "```") { s = strings.TrimSuffix(strings.TrimPrefix(s, "```"), "```") }

    type resp struct{
        Intent string   `json:"intent"`
        Name   string   `json:"name"`
        Symbol string   `json:"symbol"`
        Mint   float64  `json:"mint_price"`
        Supply int      `json:"supply"`
    }
    var r resp
    if err := jsonUnmarshalSafe(s, &r); err != nil { return Params{}, false, err }
    if strings.ToLower(r.Intent) != "yes" { return Params{}, false, nil }
    p := Params{Name: r.Name, Symbol: strings.ToUpper(r.Symbol), MintPrice: r.Mint, Supply: r.Supply}
    ok := p.Name != "" && p.Symbol != "" && p.MintPrice >= 0 && p.Supply > 0
    return p, ok, nil
}

// Minimal wrapper to avoid importing encoding/json here in case we change later
func jsonUnmarshalSafe(s string, v any) error {
    type u interface{ Unmarshal([]byte, any) error }
    return stdUnmarshal([]byte(s), v)
}

var stdUnmarshal = func(b []byte, v any) error {
    return json.Unmarshal(b, v)
}
