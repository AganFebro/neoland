// agent.go
package core

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

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

    if msg == nil {
        return fmt.Errorf("nil social message")
    }

    if msg.Platform == "discord" {
        a.logger.Infow(
            "Discord message received",
            "from", msg.FromUser,
            "content", msg.Content,
        )
    }

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

    // Fast path: Discord wallet + NFT intents -> call deploy/mint APIs
    if msg.Platform == "discord" {
        lower := strings.ToLower(msg.Content)

        // Simple wallet address query for the caller: "what is my wallet/address"
        if strings.Contains(lower, "wallet") && strings.Contains(lower, "my") && a.deployClient != nil {
            if err = a.handleWalletAddressQuery(msg); err == nil {
                return nil
            }
            a.logger.Errorw("wallet address handler failed", "error", err)
        } else if strings.Contains(lower, "wallet") {
            // Likely asking for someone else's wallet or a generic wallet lookup:
            // respond with a privacy-friendly message instead of trying to fetch.
            if err = a.handleWalletPrivacyQuery(msg); err == nil {
                return nil
            }
            a.logger.Errorw("wallet privacy handler failed", "error", err)
        }

        // Quick help/commands cheat-sheet – DM plus short ack in channel.
        // Only trigger when the user is clearly asking for help/commands,
        // not when they say things like "help me deploy...".
        if (strings.Contains(lower, "commands") ||
            (strings.Contains(lower, "help") &&
                !strings.Contains(lower, "deploy") &&
                !strings.Contains(lower, "mint"))) && a.deployClient != nil {
            if err = a.handleHelp(msg); err == nil {
                return nil
            }
            a.logger.Errorw("help handler failed", "error", err)
        }

        if a.deployClient != nil {
            // Simple collection id lookup: "collection id for X".
            // Be strict so we do not steal mint intents like
            // "mint this nft for me, the collection id is ...".
            if strings.Contains(lower, "collection id for ") &&
                !strings.Contains(lower, "mint") {
                if err = a.handleCollectionLookup(msg); err == nil {
                    return nil
                }
                a.logger.Errorw("collection lookup handler failed", "error", err)
            }

            // Discord mint intent
            if strings.Contains(lower, "mint") &&
                !strings.Contains(lower, "deploy") &&
                !strings.Contains(lower, "launch") {
                a.logger.Infow("Discord mint intent detected", "content", msg.Content)
                handled := false

                if mintParams, ok := nftdeploy.TryExtractMintParamsFast(msg.Content); ok {
                    a.logger.Infow(
                        "NFT mint fast-parse succeeded",
                        "collection_id", mintParams.CollectionID,
                        "quantity", mintParams.Quantity,
                        "currency", mintParams.Currency,
                    )
                    if err = a.handleNFTMint(msg, mintParams); err == nil {
                        return nil
                    }
                    handled = true
                    a.logger.Errorw("NFT mint via fast-parse failed", "error", err)
                }

                if !handled && a.cognitive != nil {
                    // Fallback to LLM extraction so mint commands
                    // can use more natural language.
                    mp2, ok2, e2 := nftdeploy.ExtractMintParamsLLM(
                        a.ctx,
                        a.cognitive.Client(),
                        a.cognitive.Model(),
                        msg.Content,
                    )
                    if e2 != nil {
                        a.logger.Errorw("NFT mint LLM-parse error", "error", e2)
                    } else if ok2 {
                        a.logger.Infow(
                            "NFT mint LLM-parse succeeded",
                            "collection_id", mp2.CollectionID,
                            "quantity", mp2.Quantity,
                            "currency", mp2.Currency,
                        )
                        if err = a.handleNFTMint(msg, mp2); err == nil {
                            return nil
                        }
                        handled = true
                        a.logger.Errorw("NFT mint via LLM-parse failed", "error", err)
                    }
                }

                if !handled {
                    // Looks like a mint request but we could not
                    // confidently extract a collection id.
                    guidance := "I think you want to mint from a collection, but I couldn’t clearly read the collection id. " +
                        "Please include a short id like `2feczajn` in your message, for example: " +
                        "`@neobot-test mint this NFT, collection id 2feczajn`."
                    _ = a.socialClient.SendMessage(a.ctx, SocialMessage{
                        Platform: msg.Platform,
                        Type:     "Response",
                        Content:  guidance,
                        Metadata: msg.Metadata,
                    })
                    return nil
                }
            }

            // Discord deploy intent
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
    } else {
        // Best-effort cleanup of any locally saved image copy
        if pth := a.deployClient.LastSavedFile(); pth != "" {
            if rmErr := os.Remove(pth); rmErr != nil {
                a.logger.Warnw("Failed to remove local image copy", "path", pth, "error", rmErr)
            } else {
                a.logger.Infow("Removed local image copy after successful deploy", "path", pth)
            }
        }
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
        DiscordUserID: msg.FromUser,
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
        FromUser: msg.FromUser,
        Content:  reply,
        Metadata: msg.Metadata,
    })
}

// handleNFTMint orchestrates the Discord mint helper endpoint and response messaging.
func (a *Agent) handleNFTMint(msg *SocialMessage, p nftdeploy.MintParams) error {
    if a.deployClient == nil {
        return fmt.Errorf("deploy client not configured")
    }
    // Use SOL by default unless user explicitly requested CARV.
    currency := p.Currency
    if currency != "CARV" {
        currency = "SOL"
    }
    resp, err := a.deployClient.DiscordMint(a.ctx, p.CollectionID, msg.FromUser, p.Quantity, currency)
    if err != nil {
        a.logger.Errorw("Discord mint failed", "error", err, "collection_id", p.CollectionID)
        if a.cognitive != nil {
            var emsg string
            var genErr error
            if isInsufficientBalanceError(err) {
                emsg, genErr = a.cognitive.GenerateMintBalanceErrorMessage(a.ctx, msg, currency)
            } else {
                emsg, genErr = a.cognitive.GenerateErrorMessage(a.ctx, msg, err)
            }
            if genErr == nil && strings.TrimSpace(emsg) != "" {
                return a.socialClient.SendMessage(a.ctx, SocialMessage{
                    Platform: msg.Platform,
                    Type:     "Response",
                    FromUser: msg.FromUser,
                    Content:  emsg,
                    Metadata: msg.Metadata,
                })
            }
        }
        return err
    }

    // Ask LLM for a short mint summary if available
    var reply string
    if a.cognitive != nil {
        mintedCount := len(resp.Minted)
        lastMint := ""
        if mintedCount > 0 {
            lastMint = resp.Minted[mintedCount-1].Mint
        }
        if txt, genErr := a.cognitive.GenerateMintSummary(
            a.ctx,
            msg,
            p.CollectionID,
            p.Quantity,
            currency,
            resp.Payer,
            mintedCount,
            lastMint,
        ); genErr == nil && strings.TrimSpace(txt) != "" {
            reply = txt
        }
    }
    if strings.TrimSpace(reply) == "" {
        reply = fmt.Sprintf("Minted %d NFT(s) from collection %s using %s.\nPayer wallet: %s", len(resp.Minted), p.CollectionID, currency, resp.Payer)
        if len(resp.Minted) > 0 {
            reply += "\nLast mint: " + resp.Minted[len(resp.Minted)-1].Mint
        }
    }

    return a.socialClient.SendMessage(a.ctx, SocialMessage{
        Platform: msg.Platform,
        Type:     "Response",
        FromUser: msg.FromUser,
        Content:  reply,
        Metadata: msg.Metadata,
    })
}

// handleWalletAddressQuery fetches or creates the user's Discord wallet
// and replies with the public address so they can top up SOL/CARV.
func (a *Agent) handleWalletAddressQuery(msg *SocialMessage) error {
    if a.deployClient == nil {
        return fmt.Errorf("deploy client not configured")
    }
    addr, err := a.deployClient.GetDiscordWalletPubkey(a.ctx, msg.FromUser)
    if err != nil {
        a.logger.Errorw("wallet lookup failed", "error", err)
        if a.cognitive != nil {
            if emsg, genErr := a.cognitive.GenerateErrorMessage(a.ctx, msg, err); genErr == nil && strings.TrimSpace(emsg) != "" {
                return a.socialClient.SendMessage(a.ctx, SocialMessage{
                    Platform: msg.Platform,
                    Type:     "Response",
                    Content:  emsg,
                    Metadata: msg.Metadata,
                })
            }
        }
        return err
    }
    text := fmt.Sprintf("Your minting wallet address is:\n`%s`\nYou can top up SOL or CARV there. I never show other people's addresses.", addr)
    if a.cognitive != nil {
        if txt, genErr := a.cognitive.GenerateWalletAddressSummary(a.ctx, msg, addr); genErr == nil && strings.TrimSpace(txt) != "" {
            text = txt
        }
    }
    // First, DM the wallet address to the user
    dmMsg := SocialMessage{
        Platform: msg.Platform,
        Type:     "Response",
        Content:  text,
        FromUser: msg.FromUser,
        Metadata: map[string]interface{}{"dm_user_id": msg.FromUser},
    }
    if err := a.socialClient.SendMessage(a.ctx, dmMsg); err != nil {
        a.logger.Errorw("failed to DM wallet address", "error", err)
    }
    // Then, send a short confirmation in the original channel (no address)
    confirm := "I’ve sent your minting wallet address to you via DM. Keep it safe and don’t share it with strangers."
    return a.socialClient.SendMessage(a.ctx, SocialMessage{
        Platform: msg.Platform,
        Type:     "Response",
        Content:  confirm,
        FromUser: msg.FromUser,
        Metadata: msg.Metadata,
    })
}

// handleWalletPrivacyQuery responds when a user asks for someone else's
// wallet address (or a generic wallet lookup) by explaining that neobot
// only reveals the caller's own wallet.
func (a *Agent) handleWalletPrivacyQuery(msg *SocialMessage) error {
    // Best-effort LLM explanation
    if a.cognitive != nil {
        if txt, err := a.cognitive.GenerateWalletPrivacyMessage(a.ctx, msg); err == nil && strings.TrimSpace(txt) != "" {
            return a.socialClient.SendMessage(a.ctx, SocialMessage{
                Platform: msg.Platform,
                Type:     "Response",
                Content:  txt,
                Metadata: msg.Metadata,
            })
        }
    }
    // Fallback deterministic message
    fallback := "I can only show your own minting wallet, not other people's. Ask them directly if they want to share it."
    return a.socialClient.SendMessage(a.ctx, SocialMessage{
        Platform: msg.Platform,
        Type:     "Response",
        Content:  fallback,
        Metadata: msg.Metadata,
    })
}

// handleHelp sends a short commands cheat-sheet via DM and
// a brief confirmation in the current channel.
func (a *Agent) handleHelp(msg *SocialMessage) error {
	if msg.Platform != "discord" {
		return nil
	}

	helpText := "Here’s a quick neobot cheat-sheet:\n\n" +
		"**Deploy a new collection**\n" +
		"- `@neobot-test deploy this image as NFT collection, name Neo Badge, symbol NEOB, price 0.01 SOL, supply 10000`\n" +
		"- `@neobot-test can you set up a cheap community badge, 0.005 SOL, call it Dev Badge with symbol DEVBDG, use the image I attached`\n\n" +
		"**Look up a collection id**\n" +
		"- `@neobot-test what is the collection id for CATTO SCREAM?`\n\n" +
		"**Mint from an existing collection**\n" +
		"- `@neobot-test mint from collection id pt2i38sf`\n" +
		"- `@neobot-test mint 3 from collection id pt2i38sf using CARV tokens`\n" +
		"- `i want to mint this very cool nft, here’s the id pt2i38sf @neobot-test`\n\n" +
		"I default to SOL unless you say CARV, and I usually assume quantity 1 if you don’t give a number."

	dm := SocialMessage{
		Platform: msg.Platform,
		Type:     "Response",
		Content:  helpText,
		FromUser: msg.FromUser,
		Metadata: map[string]interface{}{"dm_user_id": msg.FromUser},
	}
	if err := a.socialClient.SendMessage(a.ctx, dm); err != nil {
		return err
	}

	confirm := "I’ve sent you a DM with a quick commands cheat-sheet you can use for deploy, lookup, and mint."
	return a.socialClient.SendMessage(a.ctx, SocialMessage{
		Platform: msg.Platform,
		Type:     "Response",
		Content:  confirm,
		FromUser: msg.FromUser,
		Metadata: msg.Metadata,
	})
}

// handleCollectionLookup answers questions like
// "what is the collection id for XYZ NFT?" by querying the backend.
func (a *Agent) handleCollectionLookup(msg *SocialMessage) error {
    if a.deployClient == nil {
        return fmt.Errorf("deploy client not configured")
    }
    name := extractCollectionQuery(msg.Content)
    if name == "" {
        return nil
    }
    items, err := a.deployClient.SearchCollections(a.ctx, name)
    if err != nil {
        a.logger.Errorw("collection search failed", "error", err, "query", name)
        return err
    }
    if len(items) == 0 {
        reply := fmt.Sprintf("I couldn't find any collection whose name looks like \"%s\".", name)
        return a.socialClient.SendMessage(a.ctx, SocialMessage{
            Platform: msg.Platform,
            Type:     "Response",
            Content:  reply,
            Metadata: msg.Metadata,
        })
    }
    var reply string
    if a.cognitive != nil {
        if txt, genErr := a.cognitive.GenerateCollectionLookupSummary(a.ctx, msg, name, items); genErr == nil && strings.TrimSpace(txt) != "" {
            reply = txt
        }
    }
    if strings.TrimSpace(reply) == "" {
        if len(items) == 1 {
            c := items[0]
            reply = fmt.Sprintf("Collection id for **%s** (%s): `%s`", c.Name, c.Symbol, c.ID)
        } else {
            var b strings.Builder
            b.WriteString(fmt.Sprintf("I found multiple collections matching \"%s\":\n", name))
            for _, c := range items {
                b.WriteString(fmt.Sprintf("- `%s` — %s (%s)\n", c.ID, c.Name, c.Symbol))
            }
            reply = b.String()
        }
    }
    return a.socialClient.SendMessage(a.ctx, SocialMessage{
        Platform: msg.Platform,
        Type:     "Response",
        Content:  reply,
        Metadata: msg.Metadata,
    })
}

// extractCollectionQuery tries to pull a clean collection name from
// messages like "what is the collection id for FREEDOM? @neobot".
func extractCollectionQuery(text string) string {
    lower := strings.ToLower(text)
    idx := strings.LastIndex(lower, "for ")
    if idx == -1 {
        return ""
    }
    q := strings.TrimSpace(text[idx+4:])
    if q == "" {
        return ""
    }
    // Strip Discord mentions like <@123>, <@!123>, <#123>
    mentionRe := regexp.MustCompile(`<[@#]!?[0-9]+>`)
    q = mentionRe.ReplaceAllString(q, "")
    // Drop words that are plain @mentions (e.g., @neobot)
    parts := strings.Fields(q)
    kept := parts[:0]
    for _, p := range parts {
        if strings.HasPrefix(p, "@") {
            break
        }
        kept = append(kept, p)
    }
    q = strings.Join(kept, " ")
    // Trim common trailing punctuation
    q = strings.Trim(q, " \t\n\r\"'`?!.,")
    return strings.TrimSpace(q)
}

// isInsufficientBalanceError does a simple string match on common
// Solana/carv insufficient-funds error messages so we can give a
// more helpful LLM explanation.
func isInsufficientBalanceError(err error) bool {
    if err == nil {
        return false
    }
    s := strings.ToLower(err.Error())
    if strings.Contains(s, "insufficient funds") {
        return true
    }
    if strings.Contains(s, "insufficient lamports") {
        return true
    }
    if strings.Contains(s, "insufficient balance") {
        return true
    }
    return false
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
