package core

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"strings"
)

// AhaMomentTrigger represents different types of reconsideration triggers
type AhaMomentTrigger string

const (
	TriggerConfidenceDrop    AhaMomentTrigger = "confidence_drop"
	TriggerBetterAlternative AhaMomentTrigger = "better_alternative"
	TriggerLogicalGap        AhaMomentTrigger = "logical_gap"
	TriggerStakeholderInput  AhaMomentTrigger = "stakeholder_input"
	TriggerSimplification    AhaMomentTrigger = "simplification"
	TriggerNewInsight        AhaMomentTrigger = "new_insight"
)

// AhaMomentDetection contains detection results
type AhaMomentDetection struct {
	Triggered    bool
	Trigger      AhaMomentTrigger
	Confidence   float64
	Reason       string
	Alternatives []string
}

// detectAhaMoment implements comprehensive aha moment detection
func (e *CognitiveEngine) detectAhaMoment(
	ctx context.Context,
	currentStep *ThoughtStep,
	prevSteps []*ThoughtStep,
	alternatives []string,
	prefs map[string]interface{},
) *AhaMomentDetection {
	detection := &AhaMomentDetection{
		Triggered:  false,
		Confidence: currentStep.Confidence,
	}

	// 1. Check for explicit reconsideration language
	if trigger := e.detectExplicitReconsideration(currentStep); trigger != nil {
		return trigger
	}

	// 2. Check for confidence drop
	if trigger := e.detectConfidenceDrop(currentStep, prevSteps); trigger != nil {
		return trigger
	}

	// 3. Check for better alternatives
	if trigger := e.detectBetterAlternative(currentStep, alternatives, prefs); trigger != nil {
		return trigger
	}

	// 4. Check for logical gaps or simplification opportunities
	if trigger := e.detectLogicalImprovements(currentStep, prevSteps); trigger != nil {
		return trigger
	}

	return detection
}

// detectExplicitReconsideration checks for explicit reconsideration language
func (e *CognitiveEngine) detectExplicitReconsideration(step *ThoughtStep) *AhaMomentDetection {
	// Keywords that indicate an "aha moment"
	reconsiderationPhrases := map[string]string{
		"wait":             "Explicit pause for reconsideration",
		"hold on":          "Interruption for new insight",
		"actually":         "Correction of previous thinking",
		"better approach":  "Recognition of improved method",
		"simpler solution": "Identification of simplification",
		"just realized":    "New insight discovered",
		"alternatively":    "Alternative approach recognition",
		"more efficient":   "Efficiency improvement insight",
		"we could instead": "Alternative approach proposal",
	}

	reasoningLower := strings.ToLower(step.Content)
	for phrase, reason := range reconsiderationPhrases {
		if strings.Contains(reasoningLower, phrase) {
			return &AhaMomentDetection{
				Triggered:  true,
				Trigger:    TriggerNewInsight,
				Reason:     reason,
				Confidence: 0.9, // High confidence for explicit reconsideration
			}
		}
	}

	return nil
}

// detectConfidenceDrop checks for significant confidence decrease
func (e *CognitiveEngine) detectConfidenceDrop(
	currentStep *ThoughtStep,
	prevSteps []*ThoughtStep,
) *AhaMomentDetection {
	if len(prevSteps) == 0 {
		return nil
	}

	lastStep := prevSteps[len(prevSteps)-1]

	// Check for significant confidence drop (more than 30%)
	if currentStep.Confidence < lastStep.Confidence*0.7 {
		return &AhaMomentDetection{
			Triggered: true,
			Trigger:   TriggerConfidenceDrop,
			Reason: fmt.Sprintf("Confidence dropped from %.2f to %.2f",
				lastStep.Confidence, currentStep.Confidence),
			Confidence: currentStep.Confidence,
		}
	}

	return nil
}

// detectBetterAlternative checks if any alternative approaches are significantly better
func (e *CognitiveEngine) detectBetterAlternative(
	currentStep *ThoughtStep,
	alternatives []string,
	pref map[string]interface{},
) *AhaMomentDetection {
	for _, alt := range alternatives {
		// Score current approach
		currentScore := e.scoreApproach(currentStep.Content, pref)

		// Score alternative
		altScore := e.scoreApproach(alt, pref)

		// If alternative is significantly better (20% or more)
		if altScore > currentScore*1.2 {
			return &AhaMomentDetection{
				Triggered:    true,
				Trigger:      TriggerBetterAlternative,
				Reason:       "Found significantly better alternative approach",
				Confidence:   altScore,
				Alternatives: []string{alt},
			}
		}
	}

	return nil
}

// scoreApproach evaluates an approach considering multiple factors
func (e *CognitiveEngine) scoreApproach(approach string, pref map[string]interface{}) float64 {
	// Base score components
	scores := map[string]float64{
		"completeness":  scoreCompleteness(approach),
		"actionability": scoreActionability(approach),
		"efficiency":    scoreEfficiency(approach),
		"risk":          scoreRiskManagement(approach),
		"stakeholder":   calculateStakeholderAlignment(approach, pref),
	}

	// Weights for different components
	weights := map[string]float64{
		"completeness":  0.25,
		"actionability": 0.20,
		"efficiency":    0.15,
		"risk":          0.15,
		"stakeholder":   0.25,
	}

	// Calculate weighted sum
	var totalScore float64
	for component, score := range scores {
		totalScore += score * weights[component]
	}

	return totalScore
}

// calculateStakeholderAlignment evaluates how well an approach matches preferences
func calculateStakeholderAlignment(approach string, prefs map[string]interface{}) float64 {
	if len(prefs) == 0 {
		return 0.5
	}

	approachLower := strings.ToLower(approach)
	var totalMatch float64
	var prefCount int

	// Common preference categories with their importance weights
	prefWeights := map[string]float64{
		"performance": 1.0,
		"security":    1.0,
		"cost":        0.8,
		"efficiency":  0.8,
		"usability":   0.7,
		"quality":     0.7,
	}

	// Check each preference
	for pref, value := range prefs {
		prefCount++
		prefLower := strings.ToLower(pref)
		weight := prefWeights[prefLower]
		if weight == 0 {
			weight = 0.5 // Default weight for unlisted categories
		}

		// Check if preference is mentioned in approach
		if strings.Contains(approachLower, prefLower) {
			// Convert value to string for comparison
			valueStr := fmt.Sprintf("%v", value)
			valueLower := strings.ToLower(valueStr)

			// Check for value alignment
			switch {
			case strings.Contains(approachLower, valueLower):
				// Direct match
				totalMatch += weight * 1.0
			case isPositiveMatch(approachLower, prefLower):
				// Positive indication
				totalMatch += weight * 0.8
			case isNegativeMatch(approachLower, prefLower):
				// Negative indication
				totalMatch += weight * 0.2
			default:
				// Mentioned but unclear alignment
				totalMatch += weight * 0.5
			}
		}
	}

	if prefCount == 0 {
		return 0.5
	}

	return totalMatch / float64(prefCount)
}

// Helper functions to check positive/negative indicators
func isPositiveMatch(approach, pref string) bool {
	positiveIndicators := []string{
		"improve", "enhance", "increase",
		"better", "optimal", "efficient",
		"high", "strong", "robust",
	}

	// Check if any positive indicator is near the preference mention
	prefIndex := strings.Index(approach, pref)
	if prefIndex == -1 {
		return false
	}

	// Check surrounding context (50 characters before and after)
	start := math.Max(0, float64(prefIndex-50))
	end := math.Min(float64(len(approach)), float64(prefIndex+50))
	context := approach[int(start):int(end)]

	for _, indicator := range positiveIndicators {
		if strings.Contains(context, indicator) {
			return true
		}
	}

	return false
}

func isNegativeMatch(approach, pref string) bool {
	negativeIndicators := []string{
		"reduce", "decrease", "lower",
		"worse", "poor", "weak",
		"low", "slow", "compromise",
	}

	prefIndex := strings.Index(approach, pref)
	if prefIndex == -1 {
		return false
	}

	// Check surrounding context
	start := math.Max(0, float64(prefIndex-50))
	end := math.Min(float64(len(approach)), float64(prefIndex+50))
	context := approach[int(start):int(end)]

	for _, indicator := range negativeIndicators {
		if strings.Contains(context, indicator) {
			return true
		}
	}

	return false
}

// scoreCompleteness checks if approach covers all necessary aspects
func scoreCompleteness(approach string) float64 {
	requiredElements := []string{
		// Problem understanding
		"problem", "challenge", "requirement",
		// Solution components
		"solution", "implement", "method",
		// Validation
		"verify", "validate", "test",
		// Outcomes
		"result", "outcome", "impact",
	}

	var score float64
	approachLower := strings.ToLower(approach)

	for _, element := range requiredElements {
		if strings.Contains(approachLower, element) {
			score += 1.0 / float64(len(requiredElements))
		}
	}

	return score
}

// scoreActionability evaluates how implementable the approach is
func scoreActionability(approach string) float64 {
	actionableElements := map[string]float64{
		// Concrete actions (higher weight)
		"implement": 0.15,
		"create":    0.15,
		"deploy":    0.15,
		"configure": 0.15,

		// Steps and sequence (medium weight)
		"first":   0.1,
		"then":    0.1,
		"finally": 0.1,

		// Resources and requirements (lower weight)
		"using":    0.05,
		"requires": 0.05,
	}

	var score float64
	approachLower := strings.ToLower(approach)

	for element, weight := range actionableElements {
		if strings.Contains(approachLower, element) {
			score += weight
		}
	}

	return math.Min(1.0, score)
}

// scoreEfficiency evaluates resource usage and implementation efficiency
func scoreEfficiency(approach string) float64 {
	// Positive efficiency indicators
	positiveIndicators := []string{
		"optimize", "efficient", "streamline",
		"reuse", "leverage", "automate",
	}

	// Negative efficiency indicators
	negativeIndicators := []string{
		"complex", "manual", "repetitive",
		"expensive", "time-consuming",
	}

	approachLower := strings.ToLower(approach)

	// Calculate positive score
	var positiveScore float64
	for _, indicator := range positiveIndicators {
		if strings.Contains(approachLower, indicator) {
			positiveScore += 1.0 / float64(len(positiveIndicators))
		}
	}

	// Calculate negative score
	var negativeScore float64
	for _, indicator := range negativeIndicators {
		if strings.Contains(approachLower, indicator) {
			negativeScore += 1.0 / float64(len(negativeIndicators))
		}
	}

	return math.Max(0.0, positiveScore-negativeScore)
}

// scoreRiskManagement evaluates how well risks are addressed
func scoreRiskManagement(approach string) float64 {
	riskElements := map[string]float64{
		// Risk identification
		"risk":      0.2,
		"challenge": 0.2,
		"issue":     0.2,

		// Mitigation strategies
		"mitigate": 0.3,
		"prevent":  0.3,
		"handle":   0.3,

		// Contingency planning
		"backup":      0.2,
		"alternative": 0.2,
		"fallback":    0.2,
	}

	var score float64
	approachLower := strings.ToLower(approach)

	for element, weight := range riskElements {
		if strings.Contains(approachLower, element) {
			score += weight
		}
	}

	return math.Min(1.0, score)
}

// detectLogicalImprovements checks for logical gaps or simplification opportunities
func (e *CognitiveEngine) detectLogicalImprovements(
	currentStep *ThoughtStep,
	prevSteps []*ThoughtStep,
) *AhaMomentDetection {
	// Check for logical gaps
	if gaps := findLogicalGaps(currentStep, prevSteps); len(gaps) > 0 {
		return &AhaMomentDetection{
			Triggered:  true,
			Trigger:    TriggerLogicalGap,
			Reason:     fmt.Sprintf("Found logical gaps: %v", gaps),
			Confidence: currentStep.Confidence * 0.8, // Reduce confidence due to gaps
		}
	}

	// Check for simplification opportunities
	// if simpler := findSimplification(currentStep, prevSteps); simpler != "" {
	// 	return &AhaMomentDetection{
	// 		Triggered:    true,
	// 		Trigger:      TriggerSimplification,
	// 		Reason:       "Found simpler solution path",
	// 		Confidence:   currentStep.Confidence * 1.1, // Increase confidence for simpler path
	// 		Alternatives: []string{simpler},
	// 	}
	// }

	return nil
}

// Helper functions

func findLogicalGaps(current *ThoughtStep, previous []*ThoughtStep) []string {
	var gaps []string

	// Check for missing logical connections
	if len(previous) > 0 {
		lastStep := previous[len(previous)-1]
		if !hasLogicalConnection(current.Content, lastStep.Content) {
			gaps = append(gaps, "Missing connection to previous step")
		}
	}

	// Check for unsupported assertions
	if unsupported := findUnsupportedAssertions(current.Content); len(unsupported) > 0 {
		gaps = append(gaps, fmt.Sprintf("Unsupported assertions: %v", unsupported))
	}

	return gaps
}

func hasLogicalConnection(current, previous string) bool {
	// Check for logical connectors
	connectors := []string{
		"therefore", "thus", "hence", "consequently",
		"because", "since", "as a result", "so",
	}

	currentLower := strings.ToLower(current)
	for _, connector := range connectors {
		if strings.Contains(currentLower, connector) {
			return true
		}
	}

	return false
}

func findUnsupportedAssertions(content string) []string {
	var unsupported []string

	// Look for assertions without evidence
	assertions := findAssertions(content)
	for _, assertion := range assertions {
		if !hasEvidenceSupport(assertion, content) {
			unsupported = append(unsupported, assertion)
		}
	}

	return unsupported
}

// hasEvidenceSupport checks if an assertion has supporting evidence
func hasEvidenceSupport(assertion, content string) bool {
	// Evidence indicators
	evidenceIndicators := []string{
		"because", "since", "as shown by",
		"based on", "according to", "evidence suggests",
		"data shows", "research indicates", "proven by",
		"demonstrated by", "verified through", "tested via",
	}

	// Find the assertion in the content
	assertionIndex := strings.Index(strings.ToLower(content), strings.ToLower(assertion))
	if assertionIndex == -1 {
		return false
	}

	// Look for evidence indicators in the surrounding context
	contextWindow := 200 // characters to check before and after
	start := math.Max(0, float64(assertionIndex-contextWindow))
	end := math.Min(float64(len(content)), float64(assertionIndex+len(assertion)+contextWindow))

	context := content[int(start):int(end)]

	// Check for evidence indicators
	for _, indicator := range evidenceIndicators {
		if strings.Contains(strings.ToLower(context), indicator) {
			return true
		}
	}

	// Check for numerical evidence
	if containsNumericalEvidence(context) {
		return true
	}

	// Check for reference to external sources
	if containsExternalReference(context) {
		return true
	}

	return false
}

func containsNumericalEvidence(text string) bool {
	// Look for numbers, percentages, or measurements
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`\d+%`),
		regexp.MustCompile(`\d+\.\d+`),
		regexp.MustCompile(`\d+\s*(?:times|x)`),
	}

	for _, pattern := range patterns {
		if pattern.MatchString(text) {
			return true
		}
	}

	return false
}

func containsExternalReference(text string) bool {
	// Look for references to external sources
	referencePatterns := []string{
		"research", "study", "paper", "documentation",
		"source", "reference", "literature", "data",
	}

	textLower := strings.ToLower(text)
	for _, pattern := range referencePatterns {
		if strings.Contains(textLower, pattern) {
			return true
		}
	}

	return false
}

// findAssertions identifies claims and assertions in the reasoning
func findAssertions(reasoning string) []string {
	var assertions []string

	// Regular expressions for common assertion patterns
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`(?i)(must|should|will|always|never)\s+\w+`),
		regexp.MustCompile(`(?i)this\s+(is|will|would|could)\s+\w+`),
		regexp.MustCompile(`(?i)(?:therefore|thus|hence|consequently)\s+\w+`),
		regexp.MustCompile(`(?i)(?:because|since)\s+\w+`),
	}

	// Split reasoning into sentences
	sentences := strings.Split(reasoning, ".")

	for _, sentence := range sentences {
		sentence = strings.TrimSpace(sentence)

		// Check each pattern
		for _, pattern := range patterns {
			if matches := pattern.FindStringSubmatch(sentence); len(matches) > 0 {
				// Clean up the assertion
				assertion := cleanAssertion(sentence)
				if assertion != "" {
					assertions = append(assertions, assertion)
				}
			}
		}
	}

	return assertions
}

func cleanAssertion(assertion string) string {
	// Remove leading/trailing punctuation
	assertion = strings.Trim(assertion, ".,!?;:")

	// Remove excess whitespace
	assertion = strings.Join(strings.Fields(assertion), " ")

	return assertion
}
