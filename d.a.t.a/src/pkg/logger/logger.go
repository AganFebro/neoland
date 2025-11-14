// pkg/logger/logger.go

package logger

import "go.uber.org/zap"

var log *zap.SugaredLogger

func init() {
	logger, _ := zap.NewProduction()
	log = logger.Sugar()
}

func GetLogger() *zap.SugaredLogger {
	return log
}

// For development environment
func SetupDev() {
	logger, _ := zap.NewDevelopment()
	log = logger.Sugar()
}

// For testing environment
func SetupTest() {
	logger := zap.NewNop()
	log = logger.Sugar()
}

// For custom configuration
func SetupCustom(cfg zap.Config) error {
	logger, err := cfg.Build()
	if err != nil {
		return err
	}
	log = logger.Sugar()
	return nil
}
