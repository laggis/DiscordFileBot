import os
import logging
from dotenv import load_dotenv
import requests
import time
import hashlib
import hmac
import urllib.parse
import math

# Load environment variables
load_dotenv()

# Configuration
IIS_BASE_URL = os.getenv('IIS_BASE_URL', '').rstrip('/')
IIS_SECURE_SECRET = os.getenv('IIS_SECURE_SECRET', '')
LOCAL_FILE_PATH = os.getenv('LOCAL_FILE_PATH', '').strip('"').strip("'")
LINK_EXPIRATION_SECONDS = int(os.getenv('LINK_EXPIRATION_SECONDS', 3600))

def generate_presigned_url(object_name, expiration=None):
    """
    Generate a download URL for a file using IIS (Direct or Signed).

    :param object_name: string, the key (filename)
    :param expiration: Time in seconds for the URL to remain valid. If None, uses default.
    :return: URL as string. If error, returns None.
    """
    if expiration is None:
        expiration = LINK_EXPIRATION_SECONDS

    return generate_iis_url(object_name, expiration)

def generate_iis_url(object_name, expiration):
    """
    Generates an IIS URL. 
    If IIS_SECURE_SECRET is set, generates a signed URL for use with a validation script.
    Otherwise, generates a direct link.
    """
    if not IIS_BASE_URL:
        logging.error("IIS_BASE_URL is not set.")
        return None
    
    # If no secret, return direct link
    if not IIS_SECURE_SECRET:
        # Encode filename to be URL-safe, but allow brackets []
        safe_filename = urllib.parse.quote(object_name, safe='/[]')
        return f"{IIS_BASE_URL}/{safe_filename}"
    
    # If secret is present, generate a signed token
    # Scheme: ?file=filename&expires=timestamp&signature=hmac
    expiry_timestamp = int(time.time()) + expiration
    
    # Data to sign: filename + expiry
    data_to_sign = f"{object_name}{expiry_timestamp}"
    
    signature = hmac.new(
        IIS_SECURE_SECRET.encode('utf-8'),
        data_to_sign.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    # Construct URL (Assuming the base URL points to the script, e.g., http://site.com/download.aspx)
    # If IIS_BASE_URL ends in .php or .aspx, we append args. 
    # If it is a directory, we might need to append the script name? 
    # Let's assume IIS_BASE_URL points to the script OR the directory containing the script.
    # To be safe, let's assume IIS_BASE_URL is "http://site.com/files/" and we just return that?
    # No, if we use a secret, we MUST point to a script that validates it.
    
    # Let's append parameters.
    # If the user set IIS_BASE_URL to "http://site.com/download.php", we append ?...
    
    delimiter = '&' if '?' in IIS_BASE_URL else '?'
    
    safe_filename = urllib.parse.quote(object_name, safe='/[]')
    
    return f"{IIS_BASE_URL}{delimiter}file={safe_filename}&expires={expiry_timestamp}&signature={signature}"

def check_file_exists(object_name):
    """
    Check if a file exists on IIS.
    """
    return check_iis_file(object_name)

def check_iis_file(object_name):
    """
    Checks if file exists on IIS.
    If LOCAL_FILE_PATH is set, checks disk.
    Otherwise, sends a HEAD request to the URL.
    """
    # 1. Local Check (Preferred if on same server)
    if LOCAL_FILE_PATH:
        # Normalize path: ensure it ends with separator
        base_path = LOCAL_FILE_PATH
        if not base_path.endswith(os.sep):
            base_path += os.sep
            
        full_path = os.path.join(base_path, object_name)
        
        # Debugging output (visible in console)
        print(f"DEBUG: Checking file at path: {full_path}")
        
        return os.path.exists(full_path)

    # 2. Remote HTTP Check
    if IIS_BASE_URL:
        # Construct Direct URL for checking (even if using secure script for download)
        # We assume the file exists at BASE_URL/filename or we need to know where the actual file is.
        # If using secure script, IIS_BASE_URL might be the script.
        # This is tricky. If using secure script, we can't easily check existence via HTTP without a token.
        # So we'll try to check the direct file URL if possible.
        
        # Heuristic: If IIS_BASE_URL ends with .php/.aspx, strip it to find the directory?
        # Or just skip check if remote and secure.
        
        if IIS_SECURE_SECRET:
            # Can't check easily without generating a token, so we'll just return True or try generating a token
            # Let's generate a short-lived token just to check
            url = generate_iis_url(object_name, expiration=10)
            try:
                r = requests.head(url, timeout=2)
                return r.status_code == 200
            except:
                return True # Fail open
        else:
            # Direct link
            url = f"{IIS_BASE_URL}/{object_name}"
            try:
                r = requests.head(url, timeout=2)
                return r.status_code == 200
            except:
                return False
                
    return False

def resolve_file_path(object_name):
    """
    Attempts to find the correct file path using 'Smart Search'.
    1. Checks if the given path exists directly.
    2. If not, looks for a matching folder.
    3. If folder found, looks for the file inside it (checking variations).
    
    Returns: The resolved object_name (relative path) if found, or the original if not.
    """
    if not LOCAL_FILE_PATH:
        return object_name
        
    # Normalize base path
    base_path = LOCAL_FILE_PATH
    if not base_path.endswith(os.sep):
        base_path += os.sep
        
    print(f"DEBUG: Resolving '{object_name}' in '{base_path}'")
    
    # 1. Direct check
    full_path_direct = os.path.join(base_path, object_name)
    if os.path.exists(full_path_direct):
        print("DEBUG: Found directly.")
        return object_name
        
    # 2. Heuristic check: [Dragonfire].zip -> Dragonfire folder
    # Strip brackets and extension to get the "Core Name"
    # [Dragonfire].zip -> [Dragonfire] -> Dragonfire
    name_no_ext = os.path.splitext(object_name)[0]
    clean_name = name_no_ext.strip("[]")
    
    # Check if a folder exists with this name
    folder_path = os.path.join(base_path, clean_name)
    
    # Try finding folder with exact name, or name with brackets
    candidate_folders = [clean_name, name_no_ext]
    
    found_folder = None
    for folder in candidate_folders:
        p = os.path.join(base_path, folder)
        if os.path.isdir(p):
            found_folder = folder
            folder_path = p
            print(f"DEBUG: Found folder: {folder}")
            break
            
    if found_folder:
        # Check for the file inside this folder
        # We try: 
        # 1. Exact object_name ([Dragonfire].zip)
        # 2. Clean name + extension (Dragonfire.zip)
        # 3. Any archive file in the folder (if only one)
        
        # Supported extensions
        ARCHIVE_EXTENSIONS = ['.zip', '.rar', '.7z', '.tar', '.gz', '.tar.gz']
        
        extension = os.path.splitext(object_name)[1].lower()
        
        candidates = [
            object_name,                    # [Dragonfire].zip
            f"{clean_name}{extension}",     # Dragonfire.zip
            f"[{clean_name}]{extension}"    # [Dragonfire].zip (reconstructed)
        ]
        
        for candidate in candidates:
            heuristic_path = os.path.join(found_folder, candidate)
            full_path = os.path.join(base_path, heuristic_path)
            if os.path.exists(full_path):
                print(f"DEBUG: Found file at: {heuristic_path}")
                return heuristic_path.replace('\\', '/')
        
        # If still not found, check if there is ANY archive file in that folder?
        try:
            files = os.listdir(folder_path)
            # Find any file that matches our supported archive types
            archive_files = [f for f in files if any(f.lower().endswith(ext) for ext in ARCHIVE_EXTENSIONS)]
            
            if len(archive_files) == 1:
                 # Found exactly one archive!
                 heuristic_path = os.path.join(found_folder, archive_files[0])
                 print(f"DEBUG: Smart matched single file: {heuristic_path}")
                 return heuristic_path.replace('\\', '/')
            elif len(archive_files) > 1:
                # If the user specified an extension, filter by that
                if extension:
                    filtered_files = [f for f in archive_files if f.lower().endswith(extension)]
                    if len(filtered_files) == 1:
                        heuristic_path = os.path.join(found_folder, filtered_files[0])
                        print(f"DEBUG: Smart matched single file by extension: {heuristic_path}")
                        return heuristic_path.replace('\\', '/')
                
                print(f"DEBUG: Multiple archive files found in {found_folder}, cannot auto-select.")
        except Exception as e:
            print(f"DEBUG: Error listing files: {e}")

    # 3. Recursive Search (Fallback)
    # If not found yet, search all subdirectories for a file with the exact name.
    # Limit to searching one level deep? Or fully recursive? 
    # Let's try fully recursive but assume reasonable number of files.
    print(f"DEBUG: Starting recursive search for {object_name} in {base_path}")
    try:
        for root, dirs, files in os.walk(base_path):
            if object_name in files:
                # Found it!
                full_path = os.path.join(root, object_name)
                # Calculate relative path from base_path
                relative_path = os.path.relpath(full_path, base_path)
                print(f"DEBUG: Found via recursive search: {relative_path}")
                return relative_path.replace('\\', '/')
    except Exception as e:
        print(f"DEBUG: Error in recursive search: {e}")

    print("DEBUG: Could not resolve path automatically.")
    return object_name

def get_file_size(object_name):
    """
    Get the file size in a human-readable format (e.g., 1.2 GB).
    """
    if LOCAL_FILE_PATH:
        # Normalize path
        base_path = LOCAL_FILE_PATH
        if not base_path.endswith(os.sep):
            base_path += os.sep
            
        # Handle mixed slashes if object_name comes from resolve_file_path (which forces /)
        # os.path.join on Windows should handle it, but normpath is safer.
        full_path = os.path.normpath(os.path.join(base_path, object_name))
        
        if os.path.exists(full_path):
            try:
                size_bytes = os.path.getsize(full_path)
                return format_size(size_bytes)
            except Exception as e:
                logging.error(f"Error getting file size: {e}")
                return "Unknown"
        else:
             print(f"DEBUG: get_file_size failed. File not found at: {full_path}")
    
    return "Unknown"

def format_size(size_bytes):
    """Format bytes into human readable string"""
    if size_bytes == 0:
        return "0 B"
    size_name = ("B", "KB", "MB", "GB", "TB")
    i = int(math.floor(math.log(size_bytes, 1024)))
    p = math.pow(1024, i)
    s = round(size_bytes / p, 2)
    return f"{s} {size_name[i]}"

