package openai

import (
	"context"
	"fmt"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
)

type Client struct {
	client *openai.Client
}

type CompletionRequest struct {
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Temperature float64   `json:"temperature,omitempty"`
	MaxTokens   int       `json:"max_tokens,omitempty"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type CompletionResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
}

type EmbeddingRequest struct {
	Model string `json:"model"`
	Input string `json:"input"`
}

type EmbeddingResponse struct {
	Data []struct {
		Embedding []float64 `json:"embedding"`
	} `json:"data"`
}

func NewClient(apiKey string) *Client {
	client := openai.NewClient(
		option.WithAPIKey(apiKey), // defaults to os.LookupEnv("OPENAI_API_KEY")
	)
	return &Client{
		client: client,
	}
}

func (c *Client) CreateCompletion(ctx context.Context, req CompletionRequest) (string, error) {
	// TODO: Add more open ai api's ability to create completions
	chatCompletion, err := c.client.Chat.Completions.New(
		context.Background(),
		openai.ChatCompletionNewParams{
			Messages: openai.F(c.toOpenAIMessage(req.Messages)),
			Model:    openai.F(openai.ChatModelGPT4o),
		},
	)

	if err != nil {
		return "", fmt.Errorf("creating completion: %w", err)
	}

	return chatCompletion.Choices[0].Message.Content, nil
}

func (c *Client) toOpenAIMessage(messages []Message) []openai.ChatCompletionMessageParamUnion {
	var openAIMessages []openai.ChatCompletionMessageParamUnion
	for _, message := range messages {
		switch message.Role {
		case string(openai.ChatCompletionSystemMessageParamRoleSystem):
			openAIMessages = append(openAIMessages, openai.SystemMessage(message.Content))
		case string(openai.ChatCompletionUserMessageParamRoleUser):
			openAIMessages = append(openAIMessages, openai.UserMessage(message.Content))
		}
	}
	return openAIMessages
}
