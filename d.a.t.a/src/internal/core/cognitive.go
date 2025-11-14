package core

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/carv-protocol/d.a.t.a/src/characters"
	"github.com/carv-protocol/d.a.t.a/src/internal/actions"
	"github.com/carv-protocol/d.a.t.a/src/internal/conf"
	"github.com/carv-protocol/d.a.t.a/src/pkg/deploy"
	"github.com/carv-protocol/d.a.t.a/src/pkg/llm"
	"github.com/carv-protocol/d.a.t.a/src/pkg/logger"

	"go.uber.org/zap"
)

type promptGeneratorFunc func(StepPurpose, []*ThoughtStep) string

type StepPurpose string

const (
	PurposeInitial     StepPurpose = "initial"
	PurposeExploration StepPurpose = "exploration"
	PurposeAnalysis    StepPurpose = "analysis"
	PurposeReconsider  StepPurpose = "reconsider"
	PurposeRefinement  StepPurpose = "refinement"
	PurposeConcrete    StepPurpose = "concrete"
)

type CognitiveEngine struct {
    llm             llm.Client
    model           string
	maxSteps        int
	minConfidence   float64
	character       *characters.Character
	logger          *zap.SugaredLogger
	promptTemplates *conf.PromptTemplates
}

// Client exposes the underlying LLM client for utility parsing tasks
func (e *CognitiveEngine) Client() llm.Client { return e.llm }

// Model returns the model name used by the engine
func (e *CognitiveEngine) Model() string { return e.model }

type CognitiveConfig struct {
	NumIterations      int
	SamplesPerBatch    int
	MinRewardThreshold float64
	Temperature        float64
	MaxChainLength     int
	StabilityWindow    int
}

// ThoughtChain represents a sequence of reasoning steps
type ThoughtChain struct {
	Steps []*ThoughtStep
	// Confidence      float64
	Reflection      string
	FinalConclusion string
	Timestamp       time.Time
}

// ThoughtStep represents a single step in the reasoning process
type ThoughtStep struct {
	Type         string
	Content      string // The actual thought content
	RawLLMOutput string // Original LLM output for analysis
	Confidence   float64
	Evidence     []string
	// Verification         string
	Alternatives         []string
	ContributesToOutcome bool
	Purpose              StepPurpose
	Metadata             map[string]interface{}
	Timestamp            time.Time
}

func NewCognitiveEngine(
	llmClient llm.Client,
	model string,
	character *characters.Character,
	promptTemplates *conf.PromptTemplates,
) *CognitiveEngine {
	return &CognitiveEngine{
		llm:             llmClient,
		model:           model,
		maxSteps:        3,
		minConfidence:   0.7,
		character:       character,
		logger:          logger.GetLogger(),
		promptTemplates: promptTemplates,
	}
}

// GenerateThoughtChain creates a DeepSeek-style reasoning chain
func (e *CognitiveEngine) GenerateThoughtChain(
	ctx context.Context,
	state *SystemState,
	input interface{},
	promptGenerator promptGeneratorFunc,
) (*ThoughtChain, error) {
	e.logger.Info("Generating thought chain")
	chain := &ThoughtChain{
		Steps:     make([]*ThoughtStep, 0),
		Timestamp: time.Now(),
	}

	// Generate reasoning steps
	for i := 0; i < e.maxSteps; i++ {
		// Determine appropriate step purpose based on progress
		purpose := e.determineStepPurpose(i)

		step, err := e.generateThoughtStep(ctx, state, chain, purpose, promptGenerator)
		if err != nil {
			return nil, err
		}

		// Detect "aha moment"
		if AhaMomentDetection := e.detectAhaMoment(
			ctx, step, chain.Steps, step.Alternatives, map[string]interface{}{},
		); purpose != PurposeConcrete && AhaMomentDetection.Triggered {
			// Generate reconsideration step
			step, err = e.generateThoughtStep(ctx, state, chain, PurposeReconsider, promptGenerator)
			if err != nil {
				return nil, err
			}
		}

		e.logger.Infof("Generated step: %d, %s", i, step.Content)
		chain.Steps = append(chain.Steps, step)

		// Check if we need more steps
		if e.isConclusive(chain) {
			break
		}
	}

	return chain, nil
}

// determineStepPurpose decides appropriate purpose for current step
func (e *CognitiveEngine) determineStepPurpose(stepIndex int) StepPurpose {
	if stepIndex == 0 {
		return PurposeInitial
	}
	if stepIndex == e.maxSteps-1 {
		return PurposeConcrete
	}

	totalSteps := float64(e.maxSteps)
	progress := float64(stepIndex+1) / totalSteps

	switch {
	case progress < 0.3:
		return PurposeExploration
	case progress < 0.5:
		return PurposeAnalysis
	case progress < 0.7:
		return PurposeRefinement
	default:
		return PurposeConcrete
	}
}

// doesStepContributeToOutcome determines if step contributes to final actions/tasks
func (e *CognitiveEngine) doesStepContributeToOutcome(purpose StepPurpose, chain *ThoughtChain) bool {
	// Concrete steps always contribute
	if purpose == PurposeConcrete {
		return true
	}

	// Reconsideration steps that improve the solution contribute
	if purpose == PurposeReconsider {
		return true
	}

	// Late refinement steps often contribute
	if purpose == PurposeRefinement && len(chain.Steps) > 5 {
		return true
	}

	return false
}

func formatPreviousSteps(steps []*ThoughtStep) string {
	if len(steps) == 0 {
		return "No previous steps"
	}

	var formatted string
	for i, step := range steps {
		formatted += fmt.Sprintf("Step %d (%s):\n%s\n\n",
			i+1, step.Type, step.Content)
	}
	return formatted
}

// GenerateActions uses chain-of-thought for action planning
func (e *CognitiveEngine) GenerateActions(
	ctx context.Context,
	state *SystemState,
) (*ActionGeneration, error) {
	// Build action context
	actionContext := map[string]interface{}{
		"goal": "generate detailed action plan",
	}

	// Generate thought chain for action planning
	chain, err := e.GenerateThoughtChain(
		ctx,
		state,
		actionContext,
		generateActionsPromptFunc(state, state.AvailableActions, e.promptTemplates),
	)
	if err != nil {
		return nil, err
	}

	// Convert thought chain to actions
	actions, _ := convertThoughtChainToActions(chain)

	return &ActionGeneration{
		Actions: actions,
		Chain:   chain,
	}, nil
}

func (e *CognitiveEngine) generateThoughtStep(
	ctx context.Context,
	state *SystemState,
	chain *ThoughtChain,
	purpose StepPurpose,
	promptGenerator func(StepPurpose, []*ThoughtStep) string,
) (*ThoughtStep, error) {
	prompt := promptGenerator(purpose, chain.Steps)

	response, err := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: buildSystemPrompt(state, nil, e.promptTemplates)},
			{Role: "user", Content: prompt},
		},
	})
	if err != nil {
		return nil, err
	}

	return &ThoughtStep{
		// Core reasoning content
		Content:              extractThinkingContent(response),
		Evidence:             extractEvidence(response),
		Alternatives:         extractAlternatives(response),
		Purpose:              purpose,
		ContributesToOutcome: e.doesStepContributeToOutcome(purpose, chain),
	}, nil
}

// isConclusive determines if the reasoning chain has reached a satisfactory conclusion
func (e *CognitiveEngine) isConclusive(chain *ThoughtChain) bool {
	// Check minimum confidence threshold
	// if chain.Confidence < e.minConfidence {
	// 	return false
	// }

	// Must have at least one step
	if len(chain.Steps) == 0 {
		return false
	}

	// Check if we've addressed all key aspects
	// aspectsCovered := e.checkAspectsCoverage(chain)
	// if !aspectsCovered {
	// 	return false
	// }

	// Verify last step completion
	lastStep := chain.Steps[len(chain.Steps)-1]

	return lastStep.Purpose == PurposeConcrete
}

// Helper functions

func (e *CognitiveEngine) identifyLogicalIssues(thinking string) []string {
	var issues []string

	// Common logical fallacies and issues to check
	checks := map[string]string{
		"circular_reasoning":   `\b(because.*therefore.*because|therefore.*because.*therefore)\b`,
		"false_assumption":     `\b(must|always|never|everyone|nobody)\b`,
		"causal_fallacy":       `\b(leads to|causes|results in)\b`,
		"hasty_generalization": `\b(all|none|every|no one)\b`,
	}

	for issueType, pattern := range checks {
		if strings.Contains(thinking, pattern) {
			issues = append(issues, issueType)
		}
	}

	return issues
}

func (e *CognitiveEngine) evaluateAlternative(alternative string) float64 {
	var score float64 = 1.0

	// Evaluate completeness
	if !strings.Contains(alternative, "benefits") || !strings.Contains(alternative, "drawbacks") {
		score *= 0.8
	}

	// Check for concrete steps
	if !containsConcreteSteps(alternative) {
		score *= 0.7
	}

	// Assess feasibility
	if !assessFeasibility(alternative) {
		score *= 0.6
	}

	return score
}

// Utility functions

func parseAlternatives(response string) []string {
	// Extract alternatives between <think> tags
	alternatives := make([]string, 0)

	// Split response by <think> tags
	parts := strings.Split(response, "<think>")
	for _, part := range parts[1:] { // Skip first empty part
		if idx := strings.Index(part, "</think>"); idx != -1 {
			alt := strings.TrimSpace(part[:idx])
			alternatives = append(alternatives, alt)
		}
	}

	return alternatives
}

func containsConcreteSteps(alternative string) bool {
	// Check for numbered steps or action words
	return strings.Contains(alternative, "1.") ||
		strings.Contains(alternative, "First") ||
		strings.Contains(alternative, "Initially") ||
		strings.Contains(alternative, "Start by")
}

func assessFeasibility(alternative string) bool {
	// Check for implementation details and resource considerations
	return strings.Contains(alternative, "implement") ||
		strings.Contains(alternative, "resource") ||
		strings.Contains(alternative, "require") ||
		strings.Contains(alternative, "need")
}

func containsAspect(step string, aspect string) bool {
	aspectPatterns := map[string][]string{
		"problem_definition": {"problem", "challenge", "objective", "goal"},
		"methodology":        {"method", "approach", "strategy", "process"},
		"validation":         {"verify", "validate", "check", "confirm"},
		"risks":              {"risk", "challenge", "issue", "concern"},
		"outcomes":           {"result", "outcome", "impact", "effect"},
	}

	patterns, exists := aspectPatterns[aspect]
	if !exists {
		return false
	}

	for _, pattern := range patterns {
		if strings.Contains(strings.ToLower(step), pattern) {
			return true
		}
	}
	return false
}

func (e *CognitiveEngine) processMessage(
	ctx context.Context,
	state *SystemState,
	msg *SocialMessage,
	stakeholder *Stakeholder,
) (*ProcessedMessage, error) {
	prompt := buildMessagePrompt(state, msg, stakeholder, e.promptTemplates)
	// Get LLM's analysis
	response, err := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{
				Role:    "system",
				Content: buildSystemPrompt(state, stakeholder, e.promptTemplates),
			},
			{
				Role:    "user",
				Content: prompt,
			},
		},
	})
	if err != nil {
		return nil, err
	}

	// Parse LLM response into ProcessedMessage
	return ParseAnalysis(response)
}

func (e *CognitiveEngine) generateActionParameters(
	ctx context.Context,
	state *SystemState,
	msg *SocialMessage,
	stakeholder *Stakeholder,
	action actions.IAction,
) (map[string]interface{}, error) {
	prompt := generateActionParametersPrompt(state, msg, stakeholder, action, e.promptTemplates)
	response, err := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: buildSystemPrompt(state, stakeholder, e.promptTemplates)},
			{Role: "user", Content: prompt},
		},
	})
	if err != nil {
		return nil, err
	}

	parsedResponse, err := parseActionParameters(response)
	if err != nil {
		return nil, err
	}
	return parsedResponse, nil
}

// Helper functions
// ExtractThinkingContent extracts the core reasoning content from an LLM response.
func extractThinkingContent(response string) string {
	// Define a regex pattern to capture content within <think> tags
	pattern := `<think>(.*?)</think>`
	re := regexp.MustCompile(pattern)
	matches := re.FindStringSubmatch(response)

	if len(matches) > 1 {
		return strings.TrimSpace(matches[1])
	}

	// If no matches, return the response as-is, assuming no <think> tags were used
	return strings.TrimSpace(response)
}

func extractEvidence(response string) []string {
	// TODO: implement me
	// Extract evidence from response
	// Implementation details...
	return nil
}

func extractAlternatives(response string) []string {
	// TODO: implement me
	// Extract evidence from response
	// Implementation details...
	return nil
}

func extractAnwser(response string) []string {
	// TODO: implement me
	// Extract evidence from response
	// Implementation details...
	return nil
}

func calculateConfidence(response string) float64 {
	// TODO: implement me
	// Calculate confidence based on response
	// Implementation details...
	return 0.0
}

func generateAlternativeApproach(chain *ThoughtChain) string {
	// TODO: implement me
	// Generate alternative approach based on current chain
	// Implementation details...
	return ""
}

func ParseAnalysis(response string) (*ProcessedMessage, error) {
	if strings.HasPrefix(response, "```json") {
		response = strings.TrimPrefix(response, "```json")
		response = strings.TrimSuffix(response, "```")
		response = strings.TrimSpace(response)
	}

	var processedMsg ProcessedMessage
	if err := json.Unmarshal([]byte(response), &processedMsg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal JSON: %w", err)
	}
	return &processedMsg, nil
}

func parseActionParameters(response string) (map[string]interface{}, error) {
	if strings.HasPrefix(response, "```json") {
		response = strings.TrimPrefix(response, "```json")
		response = strings.TrimSuffix(response, "```")
		response = strings.TrimSpace(response)
	}

	var params map[string]interface{}
	if err := json.Unmarshal([]byte(response), &params); err != nil {
		return nil, fmt.Errorf("failed to unmarshal JSON: %w", err)
	}
	return params, nil
}

// GenerateDeploySummary asks the LLM to produce a playful, user-facing summary
// for an NFT deploy result, including the mint link when available.
func (e *CognitiveEngine) GenerateDeploySummary(
	ctx context.Context,
	msg *SocialMessage,
	name, symbol string,
	mintPrice float64,
	supply int,
	mintLink string,
	success bool,
) (string, error) {
	if e.llm == nil {
		return "", fmt.Errorf("llm client not initialized")
	}

	state := &SystemState{
		Character: e.character,
	}

	systemPrompt := buildSystemPrompt(state, nil, e.promptTemplates)

	status := "failed"
	if success {
		status = "succeeded"
	}

	userPrompt := fmt.Sprintf(
		"A Discord user asked me (neobot) to deploy an NFT collection. The backend call has %s.\n\n"+
			"Deployment parameters:\n- Name: %s\n- Symbol: %s\n- Mint price (SOL): %g\n- Supply: %d\n- Mint link (may be empty if missing): %s\n\n"+
			"User message:\n%s\n\n"+
			"Task: In 2–5 short lines, write a playful, friendly summary in character.\n"+
			"- If success: celebrate briefly, restate the key params, and clearly show the mint link so they can share it.\n"+
			"- If failure: be honest but kind, say that something went wrong on the backend, and suggest they try again later or ping the devs.\n"+
			"Do not expose raw error messages or stack traces.",
		status, name, symbol, mintPrice, supply, mintLink, msg.Content,
	)

	out, genErr := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	})
	if genErr != nil {
		return "", genErr
	}
	return strings.TrimSpace(out), nil
}

// GenerateMintSummary asks the LLM to summarize a successful mint action
// triggered from Discord, including how many items were minted and from which collection.
func (e *CognitiveEngine) GenerateMintSummary(
	ctx context.Context,
	msg *SocialMessage,
	collectionID string,
	quantity int,
	currency string,
	payer string,
	mintedCount int,
	lastMint string,
) (string, error) {
	if e.llm == nil {
		return "", fmt.Errorf("llm client not initialized")
	}

	state := &SystemState{
		Character: e.character,
	}

	systemPrompt := buildSystemPrompt(state, nil, e.promptTemplates)
	userPrompt := fmt.Sprintf(
		"A Discord user asked me (neobot) to mint NFTs from an existing collection.\n\n"+
			"Mint context:\n- Collection ID: %s\n- Quantity: %d\n- Currency: %s\n- Payer wallet: %s\n- Last minted mint (if any): %s\n\n"+
			"Original user message:\n%s\n\n"+
			"Task: In 2–4 short lines, write a playful, friendly summary in character that:\n"+
			"- Confirms how many NFTs were minted and from which collection id\n"+
			"- Mentions which currency was used (SOL vs CARV)\n"+
			"- Shows the payer wallet so they know where to top up funds\n"+
			"- Optionally mentions the last minted mint address if helpful.\n"+
			"- Do NOT mention or invent any Discord user IDs; the platform will mention the user separately.\n"+
			"Do not expose internal errors or stack traces.",
		collectionID, quantity, currency, payer, lastMint, msg.Content,
	)

	out, genErr := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	})
	if genErr != nil {
		return "", genErr
	}
	return strings.TrimSpace(out), nil
}

// GenerateMintBalanceErrorMessage explains that a mint failed due to
// insufficient balance and suggests topping up funds.
func (e *CognitiveEngine) GenerateMintBalanceErrorMessage(
	ctx context.Context,
	msg *SocialMessage,
	currency string,
) (string, error) {
	if e.llm == nil {
		return "", fmt.Errorf("llm client not initialized")
	}

	state := &SystemState{
		Character: e.character,
	}
	systemPrompt := buildSystemPrompt(state, nil, e.promptTemplates)

	userPrompt := fmt.Sprintf(
		"A Discord user asked me (neobot) to mint an NFT, but the transaction failed because their wallet does not have enough %s (or SOL for fees).\n\n"+
			"Original user message:\n%s\n\n"+
			"Task: In 1–3 short lines, reply in character:\n"+
			"- Clearly say that the mint failed due to insufficient balance.\n"+
			"- Mention which token they probably need to top up (use %s in your wording, but also mention network fees if relevant).\n"+
			"- Encourage them to fund the wallet and try again, without exposing any internal error text.",
		currency, msg.Content, currency,
	)

	out, genErr := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	})
	if genErr != nil {
		return "", genErr
	}
	return strings.TrimSpace(out), nil
}

// GenerateWalletAddressSummary asks the LLM to present a user's wallet
// address in-character, while keeping the address itself exact.
func (e *CognitiveEngine) GenerateWalletAddressSummary(
	ctx context.Context,
	msg *SocialMessage,
	addr string,
) (string, error) {
	if e.llm == nil {
		return "", fmt.Errorf("llm client not initialized")
	}

	state := &SystemState{
		Character: e.character,
	}
	systemPrompt := buildSystemPrompt(state, nil, e.promptTemplates)

	userPrompt := fmt.Sprintf(
		"A Discord user asked me (neobot) what their wallet address is so they can top up SOL/CARV.\n\n"+
			"Their wallet address is:\n%s\n\n"+
			"Original user message:\n%s\n\n"+
			"Task: In 1–3 short lines, reply in character.\n"+
			"- Clearly show the address in backticks so they can copy it.\n"+
			"- Mention they can top up SOL or CARV there.\n"+
			"- Explicitly say you never show other people's addresses.\n"+
			"Do NOT invent or change the address.",
		addr, msg.Content,
	)

	out, genErr := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	})
	if genErr != nil {
		return "", genErr
	}
	return strings.TrimSpace(out), nil
}

// GenerateWalletPrivacyMessage explains that the bot will not reveal
// other people's wallet addresses and only shows the caller's own wallet.
func (e *CognitiveEngine) GenerateWalletPrivacyMessage(
	ctx context.Context,
	msg *SocialMessage,
) (string, error) {
	if e.llm == nil {
		return "", fmt.Errorf("llm client not initialized")
	}

	state := &SystemState{
		Character: e.character,
	}
	systemPrompt := buildSystemPrompt(state, nil, e.promptTemplates)

	userPrompt := fmt.Sprintf(
		"A Discord user asked me (neobot) for someone else's wallet address, or for a wallet address that is not clearly their own.\n\n"+
			"User message:\n%s\n\n"+
			"Task: In 1–3 short lines, reply in character:\n"+
			"- Politely refuse to share other people's wallet addresses for privacy and security reasons.\n"+
			"- Mention that I can show *their* own minting wallet on request (e.g., \"what is my wallet address?\").\n"+
			"- Do NOT invent or expose any actual wallet address in this reply.",
		msg.Content,
	)

	out, genErr := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	})
	if genErr != nil {
		return "", genErr
	}
	return strings.TrimSpace(out), nil
}

// GenerateCollectionLookupSummary asks the LLM to present one or more
// matching collections and their ids in-character without inventing data.
func (e *CognitiveEngine) GenerateCollectionLookupSummary(
	ctx context.Context,
	msg *SocialMessage,
	query string,
	items []deploy.CollectionSearchItem,
) (string, error) {
	if e.llm == nil {
		return "", fmt.Errorf("llm client not initialized")
	}

	state := &SystemState{
		Character: e.character,
	}
	systemPrompt := buildSystemPrompt(state, nil, e.promptTemplates)

	var b strings.Builder
	for _, it := range items {
		b.WriteString(fmt.Sprintf("- id: %s | name: %s | symbol: %s\n", it.ID, it.Name, it.Symbol))
	}

	userPrompt := fmt.Sprintf(
		"A Discord user asked me (neobot) for the collection id of an NFT collection.\n\n"+
			"User query text (normalized name): %q\n\n"+
			"Matching collections (id / name / symbol):\n%s\n"+
			"Original user message:\n%s\n\n"+
			"Task: In 1–4 short lines, reply in character:\n"+
			"- If there is exactly one match: clearly show the collection id in backticks and repeat the name/symbol.\n"+
			"- If there are multiple matches: list each id on its own bullet with name and symbol so the user can choose.\n"+
			"- Make sure you ONLY use the ids and names from the list above; do NOT invent new ids or collections.",
		query, b.String(), msg.Content,
	)

	out, genErr := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	})
	if genErr != nil {
		return "", genErr
	}
	return strings.TrimSpace(out), nil
}

// GenerateErrorMessage asks the LLM to turn an internal error into a friendly,
// user-facing explanation that fits neobot's character.
func (e *CognitiveEngine) GenerateErrorMessage(
	ctx context.Context,
	msg *SocialMessage,
	err error,
) (string, error) {
	if e.llm == nil {
		return "", fmt.Errorf("llm client not initialized")
	}

	state := &SystemState{
		Character: e.character,
	}

	systemPrompt := buildSystemPrompt(state, nil, e.promptTemplates)
	userPrompt := fmt.Sprintf(
		"Context: a Discord user just tried something, and the backend returned an internal error.\n\n"+
			"User message:\n%s\n\n"+
			"Internal error (do NOT repeat this verbatim, just use it as a hint):\n%v\n\n"+
			"Task: In 1–3 short sentences, write a friendly, playful explanation to the user about why their request couldn't be completed right now. Do NOT expose stack traces or sensitive details. Suggest what they can try next (e.g., \"try again in a bit\" or \"ping the devs\").",
		msg.Content, err,
	)

	out, genErr := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	})
	if genErr != nil {
		return "", genErr
	}
	return strings.TrimSpace(out), nil
}

// GenerateClarificationMessage lets the LLM ask for missing info (e.g., NFT params)
// in a way that matches neobot's voice.
func (e *CognitiveEngine) GenerateClarificationMessage(
	ctx context.Context,
	msg *SocialMessage,
	intent string,
) (string, error) {
	if e.llm == nil {
		return "", fmt.Errorf("llm client not initialized")
	}

	state := &SystemState{
		Character: e.character,
	}

	systemPrompt := buildSystemPrompt(state, nil, e.promptTemplates)
	var userPrompt string
	switch intent {
	case "deploy_nft_missing_fields":
		userPrompt = "A user in Discord asked to deploy an NFT collection but did not provide all required fields (name, symbol, mint price in SOL, or supply).\n\n" +
			"User message:\n" + msg.Content + "\n\n" +
			"Write a short, friendly reply (2–4 lines) in character that:\n" +
			"- Confirms you understood they want to deploy an NFT\n" +
			"- Clearly lists what info you still need (name, symbol, mint price in SOL, supply)\n" +
			"- Optionally mentions they can attach an image for the collection."
	case "deploy_nft_missing_price":
		userPrompt = "A user in Discord asked to deploy an NFT collection. The parser already inferred a valid name, symbol and supply, but the mint price was missing or set to 0/free, which is not allowed.\n\n" +
			"User message:\n" + msg.Content + "\n\n" +
			"Write a short reply (2–4 lines) in character that:\n" +
			"- Says you understood their deploy request\n" +
			"- Explains that mint price cannot be 0 or 'free'\n" +
			"- Asks them to provide a mint price in SOL greater than 0, with a concrete example (e.g., 0.01 SOL)."
	default:
		userPrompt = "Write a short, friendly clarification message asking the user for missing details."
	}

	out, genErr := e.llm.CreateCompletion(ctx, llm.CompletionRequest{
		Model: e.model,
		Messages: []llm.Message{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
	})
	if genErr != nil {
		return "", genErr
	}
	return strings.TrimSpace(out), nil
}
