// agent.go
package core

import (
    "context"
    "fmt"
    "time"
    "strings"

    "github.com/carv-protocol/d.a.t.a/src/characters"
    "github.com/carv-protocol/d.a.t.a/src/internal/actions"
    "github.com/carv-protocol/d.a.t.a/src/internal/features/nftdeploy"
    "github.com/carv-protocol/d.a.t.a/src/internal/plugins"
    "github.com/carv-protocol/d.a.t.a/src/pkg/deploy"
    "github.com/carv-protocol/d.a.t.a/src/pkg/logger"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

type Agent struct {
	ID             uuid.UUID
	cognitive      *CognitiveEngine
	character      *characters.Character
	logger         *zap.SugaredLogger
	stakeholders   StakeholderManager
	tokenManager   TokenManager
	socialClient   SocialClient
    pluginRegistry *plugins.Registry
    ctx            context.Context
    cancel         context.CancelFunc
    deployClient   *deploy.Client
}

// SystemState represents the complete state of the agent system
type SystemState struct {
	// General system information
	Timestamp time.Time

	Character        *characters.Character
	AvailableActions []actions.IAction
	AvailablePlugins []plugins.Plugin
	NativeTokenInfo  *TokenInfo
	ProviderStates   []*plugins.ProviderState
}

func NewAgent(config AgentConfig) (*Agent, error) {
	if err := validateConfig(&config); err != nil {
		return nil, fmt.Errorf("invalid agent config: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())

    agent := &Agent{
        ID:             config.ID,
        character:      config.Character,
        cognitive:      NewCognitiveEngine(config.LLMClient, config.Model, config.Character, config.PromptTemplates),
        logger:         logger.GetLogger(),
        stakeholders:   config.Stakeholders,
        tokenManager:   config.TokenManager,
        socialClient:   config.SocialClient,
        pluginRegistry: config.PluginRegistry,
        ctx:            ctx,
        cancel:         cancel,
        deployClient:   config.DeployClient,
    }

	return agent, nil
}

// Main system routines
func (a *Agent) Start() error {
	a.logger.Info("Starting agent system")

	for _, account := range a.character.PriorityAccounts {
		_, err := a.stakeholders.FetchOrCreateStakeholder(
			a.ctx,
			account.ID,
			account.Platform,
			StakeholderTypePriority,
		)
		if err != nil {
			return err
		}
	}

	// Start social media monitoring
	go func() {
		a.monitorSocialInputs()
	}()

	a.socialClient.SendMessage(a.ctx, SocialMessage{
		Platform: "Twitter",
		Type:     "Response",
		Content:  "Hello, world!",
	})
	return nil
}

// In your agent_system.go
func (a *Agent) getCurrentState() *SystemState {
	nativeToken, _ := a.tokenManager.NativeTokenInfo(a.ctx)

	// Get plugin actions and provider states
	var pluginActions []actions.IAction
	var providerStates []*plugins.ProviderState

	if a.pluginRegistry != nil {
		// Collect actions from plugins
		for _, plugin := range a.pluginRegistry.GetPlugins() {
			for _, action := range plugin.Actions() {
				pluginActions = append(pluginActions, action)
			}
		}

		// Collect provider states
		for _, provider := range a.pluginRegistry.GetProviders() {
			if state, err := provider.GetProviderState(a.ctx); err == nil {
				providerStates = append(providerStates, state)
			} else {
				a.logger.Warnw("Failed to get provider state",
					"provider", provider.Name(),
					"error", err,
				)
			}
		}
	}

	// print all available actions
	for _, action := range pluginActions {
		a.logger.Infof("Available action: %s", action.Name())
	}

	// print all provider states
	for _, state := range providerStates {
		a.logger.Infof("Provider state: %+v", state)
	}

	return &SystemState{
		Character:        a.character,
		AvailableActions: pluginActions,
		Timestamp:        time.Now(),
		NativeTokenInfo:  nativeToken,
		ProviderStates:   providerStates,
	}
}

// Social media monitoring
func (a *Agent) monitorSocialInputs() {
	msgQueue := a.socialClient.GetMessageChannel()
	// TODO graceful shutdown
	go a.socialClient.MonitorMessages(a.ctx)
	for {
		select {
		case msg := <-msgQueue:
			a.processMessage(&msg)
		case <-a.ctx.Done():
			return
		}
	}
}

// executeAction executes a generic action
func (a *Agent) executeAction(ctx context.Context, action actions.IAction, params map[string]interface{}) error {
	a.logger.Infow("Executing action", "type", action.Type(), "params", params)
	return action.Execute(ctx, params)
}

func (a *Agent) processMessage(msg *SocialMessage) error {
    var err error
    defer func() {
        if err != nil {
            a.logger.Errorw("Error processing message", "error", err)
            // Let the LLM craft a friendly error message when possible
            fallback := "Something went wrong on my side. Please try again in a bit."
            if a.cognitive != nil {
                if emsg, genErr := a.cognitive.GenerateErrorMessage(a.ctx, msg, err); genErr == nil && strings.TrimSpace(emsg) != "" {
                    fallback = emsg
                }
            }
            _ = a.socialClient.SendMessage(a.ctx, SocialMessage{
                Platform: msg.Platform,
                Type:     "Response",
                Content:  fallback,
                Metadata: msg.Metadata,
            })
        }
    }()

    // Log any Discord image attachments for visibility
    if msg.Platform == "discord" && msg.Metadata != nil {
        if raw, ok := msg.Metadata["attachments"]; ok {
            var urls []string
            switch at := raw.(type) {
            case []map[string]interface{}:
                for _, m := range at {
                    if u, _ := m["url"].(string); u != "" {
                        urls = append(urls, u)
                    }
                }
            case []interface{}:
                for _, it := range at {
                    if m, ok := it.(map[string]interface{}); ok {
                        if u, _ := m["url"].(string); u != "" {
                            urls = append(urls, u)
                        }
                    }
                }
            }
            if len(urls) > 0 {
                a.logger.Infow("Discord attachments detected", "count", len(urls), "urls", urls)
            } else {
                a.logger.Infow("Discord message had attachments metadata but no URLs parsed")
            }
        }
    }

    // Fast path: Discord NFT deploy intent -> call deploy API
    if msg.Platform == "discord" && a.deployClient != nil {
        if params, ok := nftdeploy.TryExtractParamsFast(msg.Content); ok {
            a.logger.Infow("NFT fast-parse succeeded", "name", params.Name, "symbol", params.Symbol, "price", params.MintPrice, "supply", params.Supply)
            if err = a.handleNFTDeploy(msg, params); err == nil {
                return nil
            }
            a.logger.Errorw("NFT deploy via fast-parse failed", "error", err)
        } else {
            a.logger.Infoln("NFT fast-parse not conclusive; falling back to LLM parse")
            // Fallback to LLM extraction to be more flexible (including free/0 mint)
            if p2, ok2, e2 := nftdeploy.ExtractParamsLLM(a.ctx, a.cognitive.Client(), a.cognitive.Model(), msg.Content); e2 == nil && ok2 {
                a.logger.Infow("NFT LLM-parse succeeded", "name", p2.Name, "symbol", p2.Symbol, "price", p2.MintPrice, "supply", p2.Supply)
                if err = a.handleNFTDeploy(msg, p2); err == nil {
                    return nil
                }
                a.logger.Errorw("NFT deploy via LLM-parse failed", "error", err)
            } else if e2 != nil {
                a.logger.Errorw("NFT LLM-parse error", "error", e2)
            } else {
                // Still looks like a deploy intent but missing fields; guide the user
                lower := strings.ToLower(msg.Content)
                if strings.Contains(lower, "deploy") || strings.Contains(lower, "launch") {
                    // Ask the LLM to produce a helpful clarification message
                    guidance := "I see you want to deploy an NFT, but I need: name, symbol, mint price (in SOL), and supply. Example: name: \"Neo Badge\" symbol: NEOB mint: 0.02 supply: 1000."
                    if a.cognitive != nil {
                        if g, gErr := a.cognitive.GenerateClarificationMessage(a.ctx, msg, "deploy_nft_missing_fields"); gErr == nil && strings.TrimSpace(g) != "" {
                            guidance = g
                        }
                    }
                    _ = a.socialClient.SendMessage(a.ctx, SocialMessage{
                        Platform: msg.Platform,
                        Type:     "Response",
                        Content:  guidance,
                        Metadata: msg.Metadata,
                    })
                    return nil
                }
            }
        }
    }

    state := a.getCurrentState()

	stakeholder, err := a.stakeholders.FetchOrCreateStakeholder(
		a.ctx,
		msg.FromUser,
		msg.Platform,
		StakeholderTypeUser,
	)
	if err != nil {
		a.logger.Errorw("Error fetching stakeholder", "error", err)
		return err
	}

	a.logger.Infof("Priority accounts: %t", stakeholder.Type == StakeholderTypePriority)

	balance, _ := a.tokenManager.FetchNativeTokenBalance(a.ctx, msg.FromUser, msg.Platform)
	if balance != nil {
		a.logger.Infof("Native token balance: %f", balance.Balance)
		stakeholder.TokenBalance = balance
	}

	processedMsg, err := a.cognitive.processMessage(a.ctx, state, msg, stakeholder)
	if err != nil {
		a.logger.Errorw("Error processing message", "error", err)
		return err
	}

	if processedMsg.ShouldGenerateAction {
		for _, action := range processedMsg.Actions {
			var actionImpl actions.IAction
			if a.pluginRegistry != nil {
				for _, plugin := range a.pluginRegistry.GetPlugins() {
					for _, pluginAction := range plugin.Actions() {
						if pluginAction.Type() == action.ActionType && pluginAction.Name() == action.ActionName {
							actionImpl = pluginAction
							break
						}
					}
					if actionImpl != nil {
						break
					}
				}
			}

			if actionImpl == nil {
				a.logger.Errorw("Error getting action", "error", err)
				return err
			}
			a.logger.Infof("Action found in pluginRegistry: %s", actionImpl.Name())

			params, err := a.cognitive.generateActionParameters(a.ctx, state, msg, stakeholder, actionImpl)
			if err != nil {
				a.logger.Errorw("Error generating action parameters", "error", err)
				return err
			}

			if moreInfoNeeded, ok := params["more_info_needed"].(bool); ok && moreInfoNeeded {
				a.logger.Infof("More info needed, relying on message: %s", params["rely_message"])
				processedMsg.ResponseMsg = params["rely_message"].(string)
				processedMsg.ShouldReply = true
				continue
			}

			if err = a.executeAction(a.ctx, actionImpl, params); err != nil {
				a.logger.Errorw("Error executing action", "error", err)
				return err
			}
		}
	}

	a.logger.Infof("Processed message: %+v", processedMsg)
	err = a.stakeholders.AddHistoricalMsg(
		a.ctx,
		msg.FromUser,
		msg.Platform,
		[]string{
			fmt.Sprintf("%s: %s", msg.FromUser, msg.Content),
			fmt.Sprintf("%s: %s", state.Character.Name, processedMsg.ResponseMsg),
		},
	)
	if err != nil {
		a.logger.Errorw("Error adding historical message", "error", err)
		return err
	}

	if processedMsg.ShouldReply {
		// If we didn't send a response with analysis, send the original response
		a.socialClient.SendMessage(a.ctx, SocialMessage{
			Platform: msg.Platform,
			Type:     "Response",
			Content:  processedMsg.ResponseMsg,
			Metadata: msg.Metadata,
		})
	}

	// if processedMsg.ShouldGenerateTask && stakeholder.Type == StakeholderTypePriority {
	// 	a.evaluateAndExecuteTasks()
	// }

	return nil
}

// handleNFTDeploy orchestrates the deploy API call and response messaging
func (a *Agent) handleNFTDeploy(msg *SocialMessage, p nftdeploy.Params) error {
    // Build or pin metadataUri
    img := firstImageURL(msg.Metadata)
    metaURI := img
    ctType := ""
    imgCID := ""
    metaGateway := ""
    if a.deployClient != nil {
        // If a Discord image attachment is present, pin the raw image first
        if url, fn, ct := firstImageAttachment(msg.Metadata); url != "" {
            a.logger.Infow("NFT image candidate from Discord", "url", url, "filename", fn, "content_type", ct)
            tag := fmt.Sprintf("image-%s-%s", p.Name, p.Symbol)
            if pimg, err := a.deployClient.PinImage(a.ctx, url, fn, ct, tag); err == nil {
                img = pimg.Gateway
                imgCID = pimg.CID
                if imgCID == "" {
                    imgCID = extractCIDFromGateway(img)
                }
                ctType = ct
                a.logger.Infow("Image pinned successfully", "gateway", img)
                if p := a.deployClient.LastSavedFile(); p != "" {
                    a.logger.Infow("Saved local copy of image", "path", p)
                }
            } else {
                a.logger.Warnw("Pin image failed, trying metadata with original URL", "error", err)
            }
        }
        if img != "" {
            // Use lower-case "collection" to match expected format
            desc := fmt.Sprintf("%s collection", p.Name)
            if ctType == "" { ctType = "image/png" }
            if pmeta, err := a.deployClient.PinMetadata(a.ctx, p.Name, p.Symbol, desc, img, ctType); err == nil {
                // Prefer ipfs:// for metadataUri when available
                if pmeta.URI != "" {
                    metaURI = pmeta.URI
                } else if pmeta.Gateway != "" {
                    // Build ipfs:// from gateway if possible
                    if cid := extractCIDFromGateway(pmeta.Gateway); cid != "" { metaURI = "ipfs://" + cid } else { metaURI = pmeta.Gateway }
                }
                // metadataGateway should be an https URL; prefer provided gateway, else derive from ipfs://
                if pmeta.Gateway != "" {
                    metaGateway = pmeta.Gateway
                } else {
                    metaGateway = ipfsToGateway(metaURI)
                }
                a.logger.Infow("Metadata pinned successfully", "metadata_uri", metaURI, "gateway", metaGateway, "cid", pmeta.CID)
            } else {
                a.logger.Warnw("Pin metadata failed, falling back to image URL", "error", err)
            }
        }
    }

    _, err := a.deployClient.DeployNFT(a.ctx, deploy.DeployNFTRequest{
        Chain:         "carv-svm",
        Name:          p.Name,
        Symbol:        p.Symbol,
        MintPrice:     p.MintPrice,
        Supply:        p.Supply,
        DiscordUserID: msg.FromUser,
        ImageURL:      img,
        // Also populate fields expected by /api/tx/init-collection
        MetadataURI:   metaURI,
        Price:         p.MintPrice,
    })
    if err != nil {
        a.logger.Errorw("Deploy NFT failed", "error", err)
        // Continue to register off-chain so mint page can show the collection,
        // even if on-chain init tx wasn't built. The user can re-init later.
    }
    // Register collection in DB to get ID and mint link
    var mintLink string
    if id, err2 := a.deployClient.RegisterCollection(a.ctx, deploy.RegisterCollectionRequest{
        Name: p.Name,
        Symbol: p.Symbol,
        Supply: p.Supply,
        Price: p.MintPrice,
        ImageCid: imgCID,
        MetadataUri: metaURI,
        MetadataGateway: metaGateway,
        Owner: a.deployClient.DefaultOwner,
    }); err2 == nil {
        base := strings.TrimRight(a.deployClient.BaseURL, "/")
        slug := deploy.Slugify(p.Name)
        mintLink = fmt.Sprintf("%s/mint/%s-%s", base, slug, id)
        a.logger.Infow("Registered collection", "id", id, "mint_link", mintLink)
    } else {
        a.logger.Warnw("Register collection failed", "error", err2)
    }

    // Ask LLM to generate a friendly deployment summary if available
    var reply string
    if a.cognitive != nil {
        if txt, genErr := a.cognitive.GenerateDeploySummary(
            a.ctx,
            msg,
            p.Name,
            p.Symbol,
            p.MintPrice,
            p.Supply,
            mintLink,
            err == nil,
        ); genErr == nil && strings.TrimSpace(txt) != "" {
            reply = txt
        }
    }
    if strings.TrimSpace(reply) == "" {
        reply = fmt.Sprintf("NFT deployed!\nName: %s (%s)\nSupply: %d\nMint: %g", p.Name, p.Symbol, p.Supply, p.MintPrice)
        if mintLink != "" {
            reply += "\nMint link: " + mintLink
            if err != nil {
                reply += "\nNote: On-chain init failed; link is registered off-chain. Try init again later."
            }
        } else if err != nil {
            reply += "\nNote: On-chain init failed and registration also failed. Please check server logs."
        }
    }
    return a.socialClient.SendMessage(a.ctx, SocialMessage{
        Platform: msg.Platform,
        Type:     "Response",
        Content:  reply,
        Metadata: msg.Metadata,
    })
}

func firstImageURL(metadata map[string]interface{}) string {
    if metadata == nil { return "" }
    raw, ok := metadata["attachments"]
    if !ok { return "" }
    // Expecting []map[string]interface{}
    if list, ok := raw.([]map[string]interface{}); ok {
        for _, m := range list {
            if ct, _ := m["content_type"].(string); strings.HasPrefix(ct, "image/") {
                if u, _ := m["url"].(string); u != "" { return u }
            }
        }
    } else if list2, ok := raw.([]interface{}); ok {
        for _, it := range list2 {
            if m, ok := it.(map[string]interface{}); ok {
                if ct, _ := m["content_type"].(string); strings.HasPrefix(ct, "image/") {
                    if u, _ := m["url"].(string); u != "" { return u }
                }
            }
        }
    }
    return ""
}

func firstImageAttachment(metadata map[string]interface{}) (url, filename, contentType string) {
    if metadata == nil { return "", "", "" }
    raw, ok := metadata["attachments"]
    if !ok { return "", "", "" }
    if list, ok := raw.([]map[string]interface{}); ok {
        for _, m := range list {
            if ct, _ := m["content_type"].(string); strings.HasPrefix(ct, "image/") {
                u, _ := m["url"].(string)
                fn, _ := m["filename"].(string)
                return u, fn, ct
            }
        }
    } else if list2, ok := raw.([]interface{}); ok {
        for _, it := range list2 {
            if m, ok := it.(map[string]interface{}); ok {
                if ct, _ := m["content_type"].(string); strings.HasPrefix(ct, "image/") {
                    u, _ := m["url"].(string)
                    fn, _ := m["filename"].(string)
                    return u, fn, ct
                }
            }
        }
    }
    return "", "", ""
}

func extractCIDFromGateway(u string) string {
    // Expect .../ipfs/<cid>[/*][?query]
    if idx := strings.Index(u, "/ipfs/"); idx != -1 {
        rest := u[idx+len("/ipfs/"):]
        // trim after next slash or query
        for i, r := range rest {
            if r == '/' || r == '?' || r == '#' {
                return rest[:i]
            }
        }
        return rest
    }
    return ""
}

func ipfsToGateway(uri string) string {
    if strings.HasPrefix(uri, "ipfs://") {
        cid := strings.TrimPrefix(uri, "ipfs://")
        if cid != "" {
            return "https://gateway.pinata.cloud/ipfs/" + cid
        }
    }
    return uri
}

func (a *Agent) Shutdown(ctx context.Context) error {
	a.cancel()
	return nil
}
