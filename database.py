import mysql.connector
from mysql.connector import pooling
import os
import uuid
import datetime
import json
from typing import Dict, Optional
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

class Database:
    def __init__(self):
        self.host = os.getenv('MYSQL_HOST', 'localhost')
        self.user = os.getenv('MYSQL_USER', 'root')
        self.password = os.getenv('MYSQL_PASSWORD', '')
        self.database = os.getenv('MYSQL_DATABASE', 'discord_file_bot')
        self.port = int(os.getenv('MYSQL_PORT', 3306))
        
        # Connection Pool
        self.pool = None
        self._setup_pool()
        self._init_db()

    def _setup_pool(self):
        try:
            dbconfig = {
                "host": self.host,
                "user": self.user,
                "password": self.password,
                "database": self.database,
                "port": self.port
            }
            self.pool = mysql.connector.pooling.MySQLConnectionPool(
                pool_name="mypool",
                pool_size=5,
                **dbconfig
            )
        except mysql.connector.Error as err:
            print(f"Error creating connection pool: {err}")
            print("Trying to create database if it doesn't exist...")
            self._create_database()

    def _create_database(self):
        # Connect without database to create it
        try:
            conn = mysql.connector.connect(
                host=self.host,
                user=self.user,
                password=self.password,
                port=self.port
            )
            cursor = conn.cursor()
            cursor.execute(f"CREATE DATABASE IF NOT EXISTS {self.database}")
            print(f"Database {self.database} created or already exists.")
            cursor.close()
            conn.close()
            # Retry setting up pool
            self._setup_pool()
        except mysql.connector.Error as err:
            print(f"Failed to create database: {err}")

    def _init_db(self):
        if not self.pool:
            return

        try:
            conn = self.pool.get_connection()
            cursor = conn.cursor()
            
            # Create resources table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS resources (
                    id VARCHAR(36) PRIMARY KEY,
                    title TEXT,
                    description TEXT,
                    filename TEXT,
                    owner_id BIGINT,
                    created_at DOUBLE,
                    expires_at DOUBLE NULL,
                    message_id BIGINT,
                    channel_id BIGINT,
                    downloads INT DEFAULT 0,
                    direct_url TEXT
                )
            """)
            
            # Migration: Check if direct_url exists, if not add it
            cursor.execute("SHOW COLUMNS FROM resources LIKE 'direct_url'")
            if not cursor.fetchone():
                print("Migrating database: Adding direct_url column...")
                cursor.execute("ALTER TABLE resources ADD COLUMN direct_url TEXT")
                
            conn.commit()
            cursor.close()
            conn.close()
        except mysql.connector.Error as err:
            print(f"Error initializing table: {err}")

    def _get_connection(self):
        if not self.pool:
            return None
        try:
            return self.pool.get_connection()
        except mysql.connector.Error as err:
            print(f"Error getting connection from pool: {err}")
            return None

    def add_resource(self, title: str, description: str, filename: str, owner_id: int, message_id: int = None, channel_id: int = None, expiration_hours: float = None, resource_id: str = None, direct_url: str = None) -> str:
        if not resource_id:
            resource_id = str(uuid.uuid4())
        
        expires_at = None
        if expiration_hours:
            if expiration_hours <= 0:
                 expires_at = None 
            else:
                expires_at = datetime.datetime.now().timestamp() + (expiration_hours * 3600)

        conn = self._get_connection()
        if not conn:
            return None
            
        try:
            cursor = conn.cursor()
            query = """
                INSERT INTO resources 
                (id, title, description, filename, owner_id, created_at, expires_at, message_id, channel_id, downloads, direct_url)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """
            values = (
                resource_id, title, description, filename, owner_id, 
                datetime.datetime.now().timestamp(), expires_at, 
                message_id, channel_id, 0, direct_url
            )
            cursor.execute(query, values)
            conn.commit()
            cursor.close()
            return resource_id
        except mysql.connector.Error as err:
            print(f"Error adding resource: {err}")
            return None
        finally:
            conn.close()

    def get_resource(self, resource_id: str) -> Optional[Dict]:
        conn = self._get_connection()
        if not conn:
            return None
            
        try:
            cursor = conn.cursor(dictionary=True)
            cursor.execute("SELECT * FROM resources WHERE id = %s", (resource_id,))
            result = cursor.fetchone()
            cursor.close()
            return result
        except mysql.connector.Error as err:
            print(f"Error getting resource: {err}")
            return None
        finally:
            conn.close()

    def update_resource(self, resource_id: str, updates: Dict) -> bool:
        conn = self._get_connection()
        if not conn:
            return False
            
        try:
            cursor = conn.cursor()
            
            # Construct query dynamically
            set_clause = ", ".join([f"{key} = %s" for key in updates.keys()])
            values = list(updates.values())
            values.append(resource_id)
            
            query = f"UPDATE resources SET {set_clause} WHERE id = %s"
            
            cursor.execute(query, values)
            conn.commit()
            cursor.close()
            return True
        except mysql.connector.Error as err:
            print(f"Error updating resource: {err}")
            return False
        finally:
            conn.close()

    def delete_resource(self, resource_id: str) -> bool:
        conn = self._get_connection()
        if not conn:
            return False
            
        try:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM resources WHERE id = %s", (resource_id,))
            conn.commit()
            cursor.close()
            return True
        except mysql.connector.Error as err:
            print(f"Error deleting resource: {err}")
            return False
        finally:
            conn.close()

    def get_resource_by_message(self, message_id: int) -> Optional[Dict]:
        if not self.pool:
            return None
        try:
            conn = self.pool.get_connection()
            cursor = conn.cursor(dictionary=True)
            cursor.execute("SELECT * FROM resources WHERE message_id = %s", (message_id,))
            resource = cursor.fetchone()
            cursor.close()
            conn.close()
            return resource
        except mysql.connector.Error as err:
            print(f"Error fetching resource by message: {err}")
            return None

    def get_all_resources(self) -> list:
        if not self.pool:
            return []
        try:
            conn = self.pool.get_connection()
            cursor = conn.cursor(dictionary=True)
            cursor.execute("SELECT * FROM resources")
            resources = cursor.fetchall()
            cursor.close()
            conn.close()
            return resources
        except mysql.connector.Error as err:
            print(f"Error fetching all resources: {err}")
            return []
            
    # Helper to support the dictionary-like access I used in main.py?
    # No, I used db.add_resource, db.get_resource, etc.
    # BUT in main.py I did: db.data[resource_id] = { ... } manually!
    # I need to fix main.py to NOT do direct dict access.
    # The `data` attribute does not exist in this MySQL implementation.

# Singleton instance
db = Database()
