import logging
import json
import os
from typing import Dict, Any, List, Optional, TypedDict, Union
from datetime import datetime, timedelta
import aiohttp
from dotenv import load_dotenv, set_key
from src.connections.base_connection import BaseConnection, Action, ActionParameter

logger = logging.getLogger("connections.data_connection")

class DataConnectionError(Exception):
    """Base exception for Data connection errors"""
    pass

class DataConfigurationError(DataConnectionError):
    """Raised when there are configuration/credential issues"""
    pass

class DataAPIError(DataConnectionError):
    """Raised when Data API requests fail"""
    pass

class QueryResult(TypedDict):
    success: bool
    data: List[Any]
    metadata: Dict[str, Any]
    error: Optional[Dict[str, Any]]

class ApiResponse(TypedDict):
    code: int
    msg: str
    data: Dict[str, Any]

class DataConnection(BaseConnection):
    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self.chain = config.get("chain", "ethereum-mainnet")
        self.api_url = os.getenv("DATA_API_KEY")
        self.auth_token = os.getenv("DATA_AUTH_TOKEN")

    @property
    def is_llm_provider(self) -> bool:
        return False

    def validate_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Validate Data configuration from JSON"""
        required_fields = ["chain"]
        missing_fields = [field for field in required_fields if field not in config]
        if missing_fields:
            raise ValueError(f"Missing required configuration fields: {', '.join(missing_fields)}")
        return config

    def register_actions(self) -> None:
        """Register available Data actions"""
        self.actions = {
            "execute-query": Action(
                name="execute-query",
                parameters=[
                    ActionParameter("sql", True, str, "SQL query to execute"),
                ],
                description="Execute a SQL query on the blockchain data"
            ),
            "get-schema": Action(
                name="get-schema",
                parameters=[],
                description="Get the database schema"
            ),
            "get-examples": Action(
                name="get-examples",
                parameters=[],
                description="Get query examples"
            )
        }

    def _extract_sql_query(self, pre_response: Union[str, Dict[str, Any]]) -> Optional[str]:
        """Extract SQL query from response"""
        try:
            # Parse JSON if string
            json_data = pre_response
            if isinstance(pre_response, str):
                try:
                    json_data = json.loads(pre_response)
                except json.JSONDecodeError:
                    logger.error("Failed to parse pre_response as JSON")
                    return None

            def find_sql_query(obj: Any) -> Optional[str]:
                # Base cases
                if not obj:
                    return None

                # String case
                if isinstance(obj, str):
                    sql_pattern = r'^\s*(SELECT|WITH)\s+[\s\S]+?(?:;|$)'
                    comment_pattern = r'--.*$|\/\*[\s\S]*?\*\/'
                    
                    # Clean and validate string
                    clean_str = obj.strip()
                    if not clean_str:
                        return None
                        
                    # Check for unsafe keywords
                    unsafe_keywords = ['drop', 'delete', 'update', 'insert', 'alter', 'create']
                    if any(keyword in clean_str.lower() for keyword in unsafe_keywords):
                        return None
                        
                    import re
                    if re.match(sql_pattern, clean_str, re.IGNORECASE):
                        return clean_str
                    return None

                # Array case
                if isinstance(obj, list):
                    for item in obj:
                        result = find_sql_query(item)
                        if result:
                            return result
                    return None

                # Object case
                if isinstance(obj, dict):
                    # Prioritize 'query' field in sql object
                    if 'query' in obj and 'sql' in obj:
                        result = find_sql_query(obj['query'])
                        if result:
                            return result

                    # Search other fields
                    for value in obj.values():
                        result = find_sql_query(value)
                        if result:
                            return result
                    return None

                return None

            sql_query = find_sql_query(json_data)
            if not sql_query:
                logger.warning("No valid SQL query found in pre_response")
            return sql_query

        except Exception as e:
            logger.error(f"Error in extract_sql_query: {str(e)}")
            return None

    async def _send_sql_query(self, sql: str) -> ApiResponse:
        """Send SQL query to API"""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.api_url,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": self.auth_token
                    },
                    json={"sql_content": sql}
                ) as response:
                    if response.status != 200:
                        raise DataAPIError(f"HTTP error! status: {response.status}")
                    return await response.json()
        except Exception as e:
            logger.error(f"Error sending SQL query to API: {str(e)}")
            raise

    def _transform_api_response(self, api_response: ApiResponse) -> List[Dict[str, Any]]:
        """Transform API response data"""
        column_infos = api_response["data"]["column_infos"]
        rows = api_response["data"]["rows"]

        transformed_data = []
        for row in rows:
            row_data = {}
            for i, value in enumerate(row["items"]):
                column_name = column_infos[i]
                row_data[column_name] = value
            transformed_data.append(row_data)

        return transformed_data

    async def execute_query(self, sql: str) -> QueryResult:
        """Execute query with proper error handling"""
        try:
            # Validate query
            if not sql or len(sql) > 5000:
                raise DataAPIError("Invalid SQL query length")

            # Determine query type
            query_type = "token" if "token_transfers" in sql.lower() else \
                        "aggregate" if "count" in sql.lower() else \
                        "transaction"

            # Send query
            api_response = await self._send_sql_query(sql)

            # Check response status
            if api_response["code"] != 0:
                raise DataAPIError(f"API Error: {api_response['msg']}")

            # Transform data
            transformed_data = self._transform_api_response(api_response)

            return {
                "success": True,
                "data": transformed_data,
                "metadata": {
                    "total": len(transformed_data),
                    "queryTime": datetime.now().isoformat(),
                    "queryType": query_type,
                    "executionTime": 0,
                    "cached": False
                },
                "error": None
            }

        except Exception as e:
            logger.error(f"Query execution failed: {str(e)}")
            return {
                "success": False,
                "data": [],
                "metadata": {
                    "total": 0,
                    "queryTime": datetime.now().isoformat(),
                    "queryType": "unknown",
                    "executionTime": 0,
                    "cached": False
                },
                "error": {
                    "code": getattr(e, "code", "EXECUTION_ERROR"),
                    "message": str(e),
                    "details": str(e)
                }
            }

    def get_database_schema(self) -> str:
        """Get database schema"""
        return """
        CREATE EXTERNAL TABLE transactions(
            hash string,
            nonce bigint,
            block_hash string,
            block_number bigint,
            block_timestamp timestamp,
            date string,
            transaction_index bigint,
            from_address string,
            to_address string,
            value double,
            gas bigint,
            gas_price bigint,
            input string,
            max_fee_per_gas bigint,
            max_priority_fee_per_gas bigint,
            transaction_type bigint
        ) PARTITIONED BY (date string)
        ROW FORMAT SERDE 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
        STORED AS INPUTFORMAT 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat'
        OUTPUTFORMAT 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat';

        CREATE EXTERNAL TABLE token_transfers(
            token_address string,
            from_address string,
            to_address string,
            value double,
            transaction_hash string,
            log_index bigint,
            block_timestamp timestamp,
            date string,
            block_number bigint,
            block_hash string
        ) PARTITIONED BY (date string)
        ROW FORMAT SERDE 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
        STORED AS INPUTFORMAT 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat'
        OUTPUTFORMAT 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat';
        """

    def get_query_examples(self) -> str:
        """Get query examples"""
        return """
        Common Query Examples:

        1. Find Most Active Addresses in Last 7 Days:
        WITH address_activity AS (
            SELECT
                from_address AS address,
                COUNT(*) AS tx_count
            FROM
                eth.transactions
            WHERE date_parse(date, '%Y-%m-%d') >= date_add('day', -7, current_date)
            GROUP BY
                from_address
            UNION ALL
            SELECT
                to_address AS address,
                COUNT(*) AS tx_count
            FROM
                eth.transactions
            WHERE
                date_parse(date, '%Y-%m-%d') >= date_add('day', -7, current_date)
            GROUP BY
                to_address
        )
        SELECT
            address,
            SUM(tx_count) AS total_transactions
        FROM
            address_activity
        GROUP BY
            address
        ORDER BY
            total_transactions DESC
        LIMIT 10;

        2. Analyze Address Transaction Statistics (Last 30 Days):
        WITH recent_transactions AS (
            SELECT
                from_address,
                to_address,
                value,
                block_timestamp,
                CASE
                    WHEN from_address = :address THEN 'outgoing'
                    WHEN to_address = :address THEN 'incoming'
                    ELSE 'other'
                END AS transaction_type
            FROM eth.transactions
            WHERE date >= date_format(date_add('day', -30, current_date), '%Y-%m-%d')
                AND (from_address = :address OR to_address = :address)
        )
        SELECT
            transaction_type,
            COUNT(*) AS transaction_count,
            SUM(CASE WHEN transaction_type = 'outgoing' THEN value ELSE 0 END) AS total_outgoing_value,
            SUM(CASE WHEN transaction_type = 'incoming' THEN value ELSE 0 END) AS total_incoming_value
        FROM recent_transactions
        GROUP BY transaction_type;
        """

    def configure(self) -> bool:
        """Configure the Data connection"""
        logger.info("\n📊 DATA API SETUP")

        if self.is_configured():
            logger.info("\nData API is already configured.")
            response = input("Do you want to reconfigure? (y/n): ")
            if response.lower() != 'y':
                return True

        logger.info("\n📝 Please enter your Data API credentials:")
        api_key = input("Enter your Data API URL: ")
        auth_token = input("Enter your Data Auth Token: ")

        try:
            if not os.path.exists('.env'):
                with open('.env', 'w') as f:
                    f.write('')

            set_key('.env', 'DATA_API_KEY', api_key)
            set_key('.env', 'DATA_AUTH_TOKEN', auth_token)

            logger.info("\n✅ Data API configuration successfully saved!")
            return True

        except Exception as e:
            logger.error(f"Configuration failed: {e}")
            return False

    def is_configured(self, verbose: bool = False) -> bool:
        """Check if Data API credentials are configured"""
        try:
            load_dotenv()
            api_key = os.getenv('DATA_API_KEY')
            auth_token = os.getenv('DATA_AUTH_TOKEN')

            if not api_key or not auth_token:
                if verbose:
                    logger.info("Data API credentials not found")
                return False

            return True

        except Exception as e:
            if verbose:
                logger.debug(f"Configuration check failed: {e}")
            return False

    def perform_action(self, action_name: str, kwargs: Dict[str, Any]) -> Any:
        """Execute a Data action with validation"""
        if action_name not in self.actions:
            raise KeyError(f"Unknown action: {action_name}")

        action = self.actions[action_name]
        errors = action.validate_params(kwargs)
        if errors:
            raise ValueError(f"Invalid parameters: {', '.join(errors)}")

        method_name = action_name.replace('-', '_')
        method = getattr(self, method_name)
        return method(**kwargs)