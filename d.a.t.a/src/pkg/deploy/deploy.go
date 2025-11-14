package deploy

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "io"
    "encoding/base64"
    "os"
    "net/http"
    "net/url"
    "time"
    "strings"
)

// Client is a minimal HTTP client for your deploy API/server
type Client struct {
    BaseURL string
    APIKey  string
    http    *http.Client
    Path    string
    DefaultPayer string
    DefaultOwner string
    OwnerSecret  string
    SavePinImages bool
    SaveDir       string
    lastSavedPath string
}

func NewClient(baseURL, apiKey string, path string, payer string, owner string, save bool, dir string) *Client {
    return &Client{
        BaseURL: baseURL,
        APIKey:  apiKey,
        Path:    path,
        DefaultPayer: payer,
        DefaultOwner: owner,
        SavePinImages: save,
        SaveDir:       dir,
        http: &http.Client{Timeout: 15 * time.Second},
    }
}

func (c *Client) WithOwnerSecret(secret string) *Client { c.OwnerSecret = secret; return c }

// DeployNFTRequest describes the input for an NFT collection deployment
type DeployNFTRequest struct {
    // Generic fields for our flow
    Chain         string  `json:"chain,omitempty"`
    Name          string  `json:"name"`
    Symbol        string  `json:"symbol"`
    MintPrice     float64 `json:"mint_price,omitempty"`
    Supply        int     `json:"supply,omitempty"`
    DiscordUserID string  `json:"discord_user_id,omitempty"`
    ImageURL      string  `json:"image_url,omitempty"`

    // Fields expected by /api/tx/init-collection
    Payer          string  `json:"payer,omitempty"`
    Owner          string  `json:"owner,omitempty"`
    MetadataURI    string  `json:"metadataUri,omitempty"`
    CollectionMeta string  `json:"collectionMetaUri,omitempty"`
    Price          float64 `json:"price,omitempty"`
}

// DeployNFTResponse is a generic shape expected from your server
type DeployNFTResponse struct {
    Code int    `json:"code"`
    Msg  string `json:"msg"`
    Data struct {
        MintLink           string `json:"mint_link"`
        CollectionAddress  string `json:"collection_address"`
        DeployerWallet     string `json:"deployer_wallet"`
    } `json:"data"`
}

// Minimal parsing for init-collection responses
type InitCollectionResponse struct {
    Tx            string `json:"tx"`
    Already       bool   `json:"already"`
    CollectionPda string `json:"collectionPda"`
    Mint          string `json:"mint"`
}

// PinMetadataResponse is a flexible response for a pin endpoint
type PinMetadataResponse struct {
    Code int    `json:"code"`
    Msg  string `json:"msg"`
    Data struct {
        Gateway string `json:"gateway"`
        URI     string `json:"uri"`
        URL     string `json:"url"`
        Cid     string `json:"cid"`
        ImageCid string `json:"imageCid"`
        MetadataCid string `json:"metadataCid"`
        MetadataUri string `json:"metadataUri"`
    } `json:"data"`
}

type PinnedImage struct {
    Gateway string
    CID     string
}

type PinnedMetadata struct {
    Gateway string
    URI     string
    CID     string
}

// DeployNFT posts the deployment request to your API and returns the response
func (c *Client) DeployNFT(ctx context.Context, req DeployNFTRequest) (*DeployNFTResponse, error) {
    if c.BaseURL == "" {
        return nil, fmt.Errorf("deploy base URL is not configured")
    }
    endpoint := c.Path
    if endpoint == "" { endpoint = "/deploy/nft" }
    // Normalize URL join
    base := strings.TrimRight(c.BaseURL, "/")
    path := strings.TrimLeft(endpoint, "/")
    fullURL := base + "/" + path

    // Fill defaults for payer/owner if not provided.
    // For Discord (or other social) user flows where we want per-user wallets,
    // leave payer/owner empty so the backend can resolve/create the wallet
    // and build a tx that is signable by that per-user key.
    if req.DiscordUserID == "" {
        if req.Payer == "" { req.Payer = c.DefaultPayer }
        if req.Owner == "" { req.Owner = c.DefaultOwner }
    }
    if req.MetadataURI == "" && req.ImageURL != "" {
        // Some backends accept the image URL as metadataUri placeholder
        req.MetadataURI = req.ImageURL
    }
    if req.Price == 0 && req.MintPrice > 0 {
        req.Price = req.MintPrice
    }

    body, err := json.Marshal(req)
    if err != nil {
        return nil, fmt.Errorf("marshal request: %w", err)
    }

    httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, bytes.NewBuffer(body))
    if err != nil {
        return nil, fmt.Errorf("create request: %w", err)
    }
    httpReq.Header.Set("Content-Type", "application/json")
    if c.APIKey != "" {
        httpReq.Header.Set("Authorization", "Bearer "+c.APIKey)
    }

    resp, err := c.http.Do(httpReq)
    if err != nil {
        return nil, fmt.Errorf("do request: %w", err)
    }
    defer resp.Body.Close()

    // Read body for better error messages
    raw, _ := io.ReadAll(resp.Body)
    var out DeployNFTResponse
    _ = json.Unmarshal(raw, &out) // best effort for code/msg/data formats
    // Capture init-collection style responses in logs by attaching into out.Msg
    var initResp InitCollectionResponse
    _ = json.Unmarshal(raw, &initResp)
    if initResp.Tx != "" && out.Msg == "" {
        out.Msg = "init-collection-tx"
    }
    // If server returns non-standard error body, include a trimmed snippet
    msg := out.Msg
    if msg == "" && len(raw) > 0 {
        s := string(raw)
        if len(s) > 256 { s = s[:256] + "..." }
        msg = s
    }
    if resp.StatusCode < 200 || resp.StatusCode >= 300 || out.Code != 0 {
        return &out, fmt.Errorf("deploy API error: http=%d code=%d msg=%s url=%s", resp.StatusCode, out.Code, msg, fullURL)
    }
    // If this is an init-collection response, try to auto-submit.
    // For per-user Discord flows, pass discord_user_id so the backend can
    // decrypt the stored wallet secret; otherwise fall back to OwnerSecret.
    if initResp.Tx != "" && (c.OwnerSecret != "" || req.DiscordUserID != "") {
        base := strings.TrimRight(c.BaseURL, "/")
        submitURL := base + "/api/tx/submit"
        payload := map[string]interface{}{"tx": initResp.Tx}
        if req.DiscordUserID != "" {
            payload["discord_user_id"] = req.DiscordUserID
        } else {
            payload["secret"] = c.OwnerSecret
        }
        b, _ := json.Marshal(payload)
        r, err := http.NewRequestWithContext(ctx, http.MethodPost, submitURL, bytes.NewBuffer(b))
        if err == nil {
            r.Header.Set("Content-Type", "application/json")
            if c.APIKey != "" { r.Header.Set("Authorization", "Bearer "+c.APIKey) }
            resp2, err2 := c.http.Do(r)
            if err2 == nil {
                defer resp2.Body.Close()
                _, _ = io.ReadAll(resp2.Body) // drain for logging if needed
            }
        }
    }
    return &out, nil
}

// PinMetadata attempts to pin collection metadata and returns a gateway URL
// contentType optionally specifies the file MIME type for properties.files[].type
func (c *Client) PinMetadata(ctx context.Context, name, symbol, description, imageURL, contentType string) (*PinnedMetadata, error) {
    if c.BaseURL == "" { return nil, fmt.Errorf("deploy base URL is not configured") }
    base := strings.TrimRight(c.BaseURL, "/")
    // Common path name from repo tip
    fullURL := base + "/api/pin/metadata"

    if contentType == "" { contentType = "image/png" }
    payload := map[string]interface{}{
        "name": name,
        "symbol": symbol,
        "description": description,
        "image": imageURL,
        "attributes": []interface{}{},
        "properties": map[string]interface{}{
            "files": []map[string]interface{}{{
                "uri":  imageURL,
                "type": contentType,
            }},
        },
    }
    b, _ := json.Marshal(payload)
    r, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, bytes.NewBuffer(b))
    if err != nil { return nil, err }
    r.Header.Set("Content-Type", "application/json")
    if c.APIKey != "" { r.Header.Set("Authorization", "Bearer "+c.APIKey) }
    resp, err := c.http.Do(r)
    if err != nil { return nil, err }
    defer resp.Body.Close()
    raw, _ := io.ReadAll(resp.Body)
    var out PinMetadataResponse
    _ = json.Unmarshal(raw, &out)
    if resp.StatusCode < 200 || resp.StatusCode >= 300 || out.Code != 0 {
        // Try to parse direct JSON with gateway field if not nested
        var alt map[string]interface{}
        if err := json.Unmarshal(raw, &alt); err == nil {
            if gw, ok := alt["gateway"].(string); ok && gw != "" { return &PinnedMetadata{Gateway: gw}, nil }
            if uri, ok := alt["uri"].(string); ok && uri != "" { return &PinnedMetadata{URI: uri}, nil }
            if url, ok := alt["url"].(string); ok && url != "" { return &PinnedMetadata{Gateway: url}, nil }
        }
        // fallback to raw string
        msg := out.Msg
        if msg == "" { s := string(raw); if len(s) > 256 { s = s[:256]+"..." }; msg = s }
        return nil, fmt.Errorf("pin metadata error: http=%d msg=%s url=%s", resp.StatusCode, msg, fullURL)
    }
    if out.Data.Gateway != "" || out.Data.URI != "" || out.Data.URL != "" || out.Data.Cid != "" || out.Data.MetadataCid != "" || out.Data.MetadataUri != "" {
        return &PinnedMetadata{
            Gateway: func() string { if out.Data.Gateway != "" { return out.Data.Gateway }; if out.Data.URL != "" { return out.Data.URL }; return "" }(),
            URI: func() string { if out.Data.URI != "" { return out.Data.URI }; if out.Data.MetadataUri != "" { return out.Data.MetadataUri }; if out.Data.Cid != "" { return "ipfs://"+out.Data.Cid }; if out.Data.MetadataCid != "" { return "ipfs://"+out.Data.MetadataCid }; return "" }(),
            CID: func() string { if out.Data.Cid != "" { return out.Data.Cid }; if out.Data.MetadataCid != "" { return out.Data.MetadataCid }; return "" }(),
        }, nil
    }
    // Some servers return flat JSON on success
    var alt map[string]interface{}
    if err := json.Unmarshal(raw, &alt); err == nil {
        if gw, ok := alt["gateway"].(string); ok && gw != "" { return &PinnedMetadata{Gateway: gw}, nil }
        if uri, ok := alt["uri"].(string); ok && uri != "" { return &PinnedMetadata{URI: uri}, nil }
        if url, ok := alt["url"].(string); ok && url != "" { return &PinnedMetadata{Gateway: url}, nil }
        if cid, ok := alt["cid"].(string); ok && cid != "" { return &PinnedMetadata{URI: "ipfs://"+cid, CID: cid}, nil }
    }
    return nil, fmt.Errorf("pin metadata: empty response")
}

// PinImage downloads an image and POSTs base64 data to /api/pin/image.
// Returns a public gateway URL suitable for NFT metadata.
// PinImage pins image by posting JSON with base64 data
// Returns the gateway URL if available
func (c *Client) PinImage(ctx context.Context, imageURL, filename, contentType, nameTag string) (*PinnedImage, error) {
    if c.BaseURL == "" { return nil, fmt.Errorf("deploy base URL is not configured") }
    base := strings.TrimRight(c.BaseURL, "/")
    fullURL := base + "/api/pin/image"

    // Download image
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, imageURL, nil)
    if err != nil { return nil, err }
    resp, err := c.http.Do(req)
    if err != nil { return nil, err }
    defer resp.Body.Close()
    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        return nil, fmt.Errorf("download image error: http=%d", resp.StatusCode)
    }
    data, err := io.ReadAll(resp.Body)
    if err != nil { return nil, err }

    // Optionally persist a local copy for debugging
    if c.SavePinImages {
        if filename == "" { filename = fmt.Sprintf("image_%d.bin", time.Now().UnixNano()) }
        dir := c.SaveDir
        if dir == "" { dir = "./data/tmp" }
        // ensure dir
        _ = os.MkdirAll(dir, 0o755)
        path := strings.TrimRight(dir, "/") + "/" + filename
        if err := os.WriteFile(path, data, 0o644); err == nil {
            c.lastSavedPath = path
        }
    }

    if contentType == "" { contentType = http.DetectContentType(data) }
    if nameTag == "" { nameTag = "nft-image" }
    enc := base64.StdEncoding.EncodeToString(data)

    payload := map[string]string{
        "filename": filename,
        "contentType": contentType,
        "dataBase64": enc,
        "nameTag": nameTag,
    }
    body, _ := json.Marshal(payload)

    // POST as JSON
    post, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, bytes.NewBuffer(body))
    if err != nil { return nil, err }
    post.Header.Set("Content-Type", "application/json")
    if c.APIKey != "" { post.Header.Set("Authorization", "Bearer "+c.APIKey) }
    r, err := c.http.Do(post)
    if err != nil { return nil, err }
    defer r.Body.Close()
    raw, _ := io.ReadAll(r.Body)

    var out PinMetadataResponse
    _ = json.Unmarshal(raw, &out)
    if r.StatusCode < 200 || r.StatusCode >= 300 || out.Code != 0 {
        // Try best-effort field
        var alt map[string]interface{}
        if err := json.Unmarshal(raw, &alt); err == nil {
            if gw, ok := alt["gateway"].(string); ok && gw != "" { return &PinnedImage{Gateway: gw}, nil }
            if url, ok := alt["url"].(string); ok && url != "" { return &PinnedImage{Gateway: url}, nil }
            if uri, ok := alt["uri"].(string); ok && uri != "" { return &PinnedImage{Gateway: uri}, nil }
            if mu, ok := alt["metadataUri"].(string); ok && mu != "" { return &PinnedImage{Gateway: mu}, nil }
            if cid, ok := alt["imageCid"].(string); ok && cid != "" { return &PinnedImage{Gateway: "https://gateway.pinata.cloud/ipfs/"+cid, CID: cid}, nil }
            if cid, ok := alt["cid"].(string); ok && cid != "" { return &PinnedImage{Gateway: "https://gateway.pinata.cloud/ipfs/"+cid, CID: cid}, nil }
        }
        msg := out.Msg
        if msg == "" { s := string(raw); if len(s) > 256 { s = s[:256]+"..." }; msg = s }
        return nil, fmt.Errorf("pin image error: http=%d msg=%s", r.StatusCode, msg)
    }
    if out.Data.Gateway != "" || out.Data.URL != "" || out.Data.URI != "" || out.Data.Cid != "" || out.Data.ImageCid != "" {
        return &PinnedImage{
            Gateway: func() string { if out.Data.Gateway != "" { return out.Data.Gateway }; if out.Data.URL != "" { return out.Data.URL }; if out.Data.URI != "" { return out.Data.URI }; if out.Data.Cid != "" { return "https://gateway.pinata.cloud/ipfs/"+out.Data.Cid }; if out.Data.ImageCid != "" { return "https://gateway.pinata.cloud/ipfs/"+out.Data.ImageCid }; return "" }(),
            CID: func() string { if out.Data.ImageCid != "" { return out.Data.ImageCid }; if out.Data.Cid != "" { return out.Data.Cid }; return "" }(),
        }, nil
    }
    // Some servers return flat JSON even on success; try parsing
    var alt map[string]interface{}
    if err := json.Unmarshal(raw, &alt); err == nil {
        if gw, ok := alt["gateway"].(string); ok && gw != "" { return &PinnedImage{Gateway: gw}, nil }
        if uri, ok := alt["uri"].(string); ok && uri != "" { return &PinnedImage{Gateway: uri}, nil }
        if url, ok := alt["url"].(string); ok && url != "" { return &PinnedImage{Gateway: url}, nil }
        if cid, ok := alt["imageCid"].(string); ok && cid != "" { return &PinnedImage{Gateway: "https://gateway.pinata.cloud/ipfs/"+cid, CID: cid}, nil }
        if cid, ok := alt["cid"].(string); ok && cid != "" { return &PinnedImage{Gateway: "https://gateway.pinata.cloud/ipfs/"+cid, CID: cid}, nil }
    }
    return nil, fmt.Errorf("pin image: empty response")
}

// Register collection in backend DB and return the generated ID
type RegisterCollectionRequest struct {
    Name            string  `json:"name"`
    Symbol          string  `json:"symbol"`
    Supply          int     `json:"supply"`
    Price           float64 `json:"price"`
    ImageCid        string  `json:"imageCid,omitempty"`
    MetadataUri     string  `json:"metadataUri"`
    MetadataGateway string  `json:"metadataGateway"`
    Owner           string  `json:"owner"`
    OnchainPda      string  `json:"onchainPda,omitempty"`
    DiscordUserID   string  `json:"discord_user_id,omitempty"`
}

type RegisterCollectionResponse struct { ID string `json:"id"` }

func (c *Client) RegisterCollection(ctx context.Context, req RegisterCollectionRequest) (string, error) {
    base := strings.TrimRight(c.BaseURL, "/")
    fullURL := base + "/api/deploy/config"
    b, _ := json.Marshal(req)
    r, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, bytes.NewBuffer(b))
    if err != nil { return "", err }
    r.Header.Set("Content-Type", "application/json")
    resp, err := c.http.Do(r)
    if err != nil { return "", err }
    defer resp.Body.Close()
    raw, _ := io.ReadAll(resp.Body)
    var out RegisterCollectionResponse
    if err := json.Unmarshal(raw, &out); err != nil { return "", fmt.Errorf("register decode: %w", err) }
    if resp.StatusCode < 200 || resp.StatusCode >= 300 || out.ID == "" {
        s := string(raw)
        if len(s) > 256 { s = s[:256]+"..." }
        return "", fmt.Errorf("register error: http=%d body=%s", resp.StatusCode, s)
    }
    return out.ID, nil
}

type DiscordWalletResponse struct {
    Pubkey string `json:"pubkey"`
}

// GetDiscordWalletPubkey resolves (or creates) a per-user wallet for a Discord user
// and returns the public key. Requires the backend to be configured with DEPLOY_API_KEY.
func (c *Client) GetDiscordWalletPubkey(ctx context.Context, discordUserID string) (string, error) {
    if c.BaseURL == "" {
        return "", fmt.Errorf("deploy base URL is not configured")
    }
    if strings.TrimSpace(discordUserID) == "" {
        return "", fmt.Errorf("discord user id required")
    }
    base := strings.TrimRight(c.BaseURL, "/")
    fullURL := base + "/api/discord/wallet"
    payload := map[string]string{"discord_user_id": discordUserID}
    b, _ := json.Marshal(payload)
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, bytes.NewBuffer(b))
    if err != nil {
        return "", err
    }
    req.Header.Set("Content-Type", "application/json")
    if c.APIKey != "" {
        req.Header.Set("Authorization", "Bearer "+c.APIKey)
    }
    resp, err := c.http.Do(req)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()
    raw, _ := io.ReadAll(resp.Body)
    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        var alt map[string]interface{}
        msg := ""
        if err := json.Unmarshal(raw, &alt); err == nil {
            if s, ok := alt["error"].(string); ok {
                msg = s
            }
        }
        if msg == "" {
            msg = string(raw)
            if len(msg) > 256 { msg = msg[:256] + "..." }
        }
        return "", fmt.Errorf("discord wallet error: http=%d msg=%s", resp.StatusCode, msg)
    }
    var out DiscordWalletResponse
    if err := json.Unmarshal(raw, &out); err != nil {
        return "", fmt.Errorf("decode wallet response: %w", err)
    }
    if strings.TrimSpace(out.Pubkey) == "" {
        return "", fmt.Errorf("wallet pubkey missing in response")
    }
    return out.Pubkey, nil
}

type CollectionSearchItem struct {
    ID               string `json:"id"`
    Name             string `json:"name"`
    Symbol           string `json:"symbol"`
    ImageGateway     string `json:"image_gateway"`
    PriceLamports    int64  `json:"priceLamports"`
    LimitOnePerWallet bool  `json:"limitOnePerWallet"`
}

type collectionSearchResponse struct {
    Items []CollectionSearchItem `json:"items"`
}

// SearchCollections finds collections whose name contains the query (case-insensitive).
func (c *Client) SearchCollections(ctx context.Context, name string) ([]CollectionSearchItem, error) {
    if c.BaseURL == "" {
        return nil, fmt.Errorf("deploy base URL is not configured")
    }
    q := strings.TrimSpace(name)
    if q == "" {
        return nil, fmt.Errorf("name is required")
    }
    base := strings.TrimRight(c.BaseURL, "/")
    fullURL := base + "/api/collections/search?name=" + url.QueryEscape(q)
    req, err := http.NewRequestWithContext(ctx, http.MethodGet, fullURL, nil)
    if err != nil {
        return nil, err
    }
    if c.APIKey != "" {
        req.Header.Set("Authorization", "Bearer "+c.APIKey)
    }
    resp, err := c.http.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    raw, _ := io.ReadAll(resp.Body)
    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        var alt map[string]interface{}
        msg := ""
        if err := json.Unmarshal(raw, &alt); err == nil {
            if s, ok := alt["error"].(string); ok {
                msg = s
            }
        }
        if msg == "" {
            msg = string(raw)
            if len(msg) > 256 { msg = msg[:256] + "..." }
        }
        return nil, fmt.Errorf("collection search error: http=%d msg=%s", resp.StatusCode, msg)
    }
    var out collectionSearchResponse
    if err := json.Unmarshal(raw, &out); err != nil {
        return nil, fmt.Errorf("decode search response: %w", err)
    }
    return out.Items, nil
}

type DiscordMintItem struct {
    Mint      string `json:"mint"`
    Signature string `json:"signature"`
}

type DiscordMintResponse struct {
    OK     bool              `json:"ok"`
    Minted []DiscordMintItem `json:"minted"`
    Payer  string            `json:"payer"`
}

// DiscordMint calls the backend's /api/discord/mint helper to mint NFTs for a Discord user.
// currency should be "SOL" or "CARV" (case-insensitive). Quantity defaults to 1 if <=0.
func (c *Client) DiscordMint(ctx context.Context, collectionID, discordUserID string, quantity int, currency string) (*DiscordMintResponse, error) {
    if c.BaseURL == "" {
        return nil, fmt.Errorf("deploy base URL is not configured")
    }
    if strings.TrimSpace(collectionID) == "" || strings.TrimSpace(discordUserID) == "" {
        return nil, fmt.Errorf("collection id and discord user id required")
    }
    if quantity <= 0 {
        quantity = 1
    }
    base := strings.TrimRight(c.BaseURL, "/")
    fullURL := base + "/api/discord/mint"
    payload := map[string]interface{}{
        "id":              collectionID,
        "discord_user_id": discordUserID,
        "quantity":        quantity,
    }
    cur := strings.ToUpper(strings.TrimSpace(currency))
    if cur == "CARV" || cur == "SOL" {
        payload["currency"] = cur
    }
    b, _ := json.Marshal(payload)
    req, err := http.NewRequestWithContext(ctx, http.MethodPost, fullURL, bytes.NewBuffer(b))
    if err != nil {
        return nil, err
    }
    req.Header.Set("Content-Type", "application/json")
    if c.APIKey != "" {
        req.Header.Set("Authorization", "Bearer "+c.APIKey)
    }
    resp, err := c.http.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()
    raw, _ := io.ReadAll(resp.Body)
    if resp.StatusCode < 200 || resp.StatusCode >= 300 {
        var alt map[string]interface{}
        msg := ""
        if err := json.Unmarshal(raw, &alt); err == nil {
            // Prefer a detailed message if present
            if s, ok := alt["detail"].(string); ok && s != "" {
                msg = s
            } else if s, ok := alt["error"].(string); ok && s != "" {
                msg = s
            }
        }
        if msg == "" {
            msg = string(raw)
            if len(msg) > 256 {
                msg = msg[:256] + "..."
            }
        }
        return nil, fmt.Errorf("discord mint error: http=%d msg=%s", resp.StatusCode, msg)
    }
    var out DiscordMintResponse
    if err := json.Unmarshal(raw, &out); err != nil {
        return nil, fmt.Errorf("decode discord mint response: %w", err)
    }
    if !out.OK {
        return &out, fmt.Errorf("discord mint reported failure")
    }
    return &out, nil
}

func Slugify(s string) string {
    s = strings.ToLower(s)
    // keep alnum and dash
    var b strings.Builder
    prevDash := false
    for _, r := range s {
        if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
            b.WriteRune(r); prevDash=false
        } else {
            if !prevDash { b.WriteByte('-'); prevDash=true }
        }
    }
    out := b.String()
    out = strings.Trim(out, "-")
    if out == "" { out = "collection" }
    return out
}

// LastSavedFile returns the path of the last locally-saved image copy
func (c *Client) LastSavedFile() string { return c.lastSavedPath }
